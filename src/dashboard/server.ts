// The dashboard: a separate program that listens for the pipeline's telemetry, reads its
// finished records, and serves a live page. Nothing here runs inside the pipeline.
//
//   npm run dashboard            # then open http://localhost:4000
//
//   pipeline ── UDP, fire-and-forget ──► this server ── server-sent events ──► the page
//                                          ▲
//                 data/decisions/*.jsonl ──┘  (finished records: what the price did next)

import dgram from 'node:dgram';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, envNum } from '../config.ts';
import type { DecisionRecord } from '../engine.ts';
import { log } from '../lib/run.ts';
import { fillLeans, LeanBook } from '../model/lean.ts';
import type { NewsRecord } from '../news/engine.ts';
import { DEFAULT_TELEMETRY_PORT } from '../telemetry/sender.ts';
import type { TelemetryEvent } from '../telemetry/events.ts';
import { DashboardState, type DashboardEvent, type ServerEvent } from './collector.ts';
import type { NewsItem } from '../news/types.ts';
import { liveOutcome, newsOutcome, restoredEntry, scoreboard } from './outcomes.ts';
import { pnlReport } from './pnl.ts';

const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const HTTP_PORT = envNum('DASHBOARD_PORT', 4000, { min: 1 });
const UDP_PORT = envNum('TELEMETRY_PORT', DEFAULT_TELEMETRY_PORT, { min: 1 });
const MAX_SPREAD_BPS = envNum('MAX_SPREAD_BPS', 50, { min: 0 });
/** The stake behind each trade, so the running total can be shown in money. */
const NOTIONAL_USD = envNum('PNL_NOTIONAL_USD', 10_000, { min: 0 });
const DECISIONS_DIR = 'data/decisions';
const ITEMS_DIR = 'data/news';
/** Finished decisions the scoreboard looks back over (about 50 minutes at one a second). */
const SCORE_WINDOW = 3000;
/** When first opening a records file, read at most this much from its end (a long run can be 100 MB). */
const BACKFILL_BYTES = 4 * 1024 * 1024;

const HERE = dirname(fileURLToPath(import.meta.url));
const state = new DashboardState();
let seq = 0;

// ---- out to browsers: server-sent events, handed over in small batches ----------------------

const clients = new Set<http.ServerResponse>();
let outbox: DashboardEvent[] = [];

function publish(e: TelemetryEvent | ServerEvent) {
  const stamped = { ...e, rx: Date.now(), seq: ++seq } as DashboardEvent;
  state.apply(stamped);
  outbox.push(stamped);
}

setInterval(() => {
  if (outbox.length === 0) return;
  const message = `data: ${JSON.stringify(outbox)}\n\n`;
  outbox = [];
  for (const res of clients) res.write(message);
}, 200);
setInterval(() => {
  for (const res of clients) res.write(': still here\n\n'); // keeps idle connections from being closed
}, 15_000);

// ---- in from the pipeline: UDP datagrams, one JSON message per line --------------------------

const PROGRAMS = new Set(['live', 'news']);
const udp = dgram.createSocket('udp4');
let received = 0;
let rejected = 0;
udp.on('message', datagram => {
  for (const line of datagram.toString().split('\n')) {
    try {
      const e = JSON.parse(line) as TelemetryEvent;
      if (e?.v !== 1 || typeof e.type !== 'string' || !PROGRAMS.has(e.program)) throw new Error('not a telemetry message');
      received++;
      publish(e);
    } catch {
      rejected++; // anything can arrive on a UDP port; ignore what we do not understand
    }
  }
});
udp.on('error', error => log(`telemetry socket: ${error.message}`));
udp.bind(UDP_PORT, HOST);

// ---- finished records: what the price did after each decision ---------------------------------

type Tail = { prefix: string; file?: string; offset: number; partial: string };
const tails: Record<'live' | 'news', Tail> = { live: { prefix: 'live-', offset: 0, partial: '' }, news: { prefix: 'news-', offset: 0, partial: '' } };
let scored: DecisionRecord[] = [];
let scoreDirty = false;
/**
 * Records saved by a pipeline from before it read Jev's lean against its usual one carry no such
 * reading. They are given one here, worked out exactly as a live run would have, so an older run
 * can still be scored the new way. A record that has its own is left alone.
 */
let leans = new LeanBook();
/**
 * Finished news about the traded instrument, oldest first, for the selective profit-and-loss
 * strategy's "did a recent headline agree" check. A headline stays useful long after the pipeline
 * that reported it restarts, so this is never cleared the way `scored` is.
 */
let newsForPnl: NewsRecord[] = [];
const NEWS_FOR_PNL_LIMIT = 500;

/**
 * The file of the most recently STARTED run (its start time is in its name). Not the most
 * recently written one: with two runs going at once that would flip back and forth between them.
 */
function newest(prefix: string, dir = DECISIONS_DIR): string | undefined {
  if (!existsSync(dir)) return undefined;
  const startedAt = (f: string) => /\d{4}-\d{2}-\d{2}T[\d-]+Z/.exec(f)?.[0] ?? '';
  return readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'))
    .sort((a, b) => startedAt(b).localeCompare(startedAt(a)))[0];
}

/** A damaged line (a crash mid-write, say) is skipped and mentioned once, not allowed to block the rest. */
let damagedLines = 0;
function parseLines<T>(lines: string[]): T[] {
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      if (damagedLines++ === 0) log('a line in the pipeline\'s result files could not be read and was skipped (further ones are skipped quietly)');
    }
  }
  return out;
}

/** The complete lines in the last `bytes` of a file. */
function tailLines(path: string, bytes = BACKFILL_BYTES): string[] {
  const size = statSync(path).size;
  const from = Math.max(0, size - bytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString().split('\n');
    if (from > 0) lines.shift(); // we started somewhere inside a record
    return lines.filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

/**
 * News is sparse, so a dashboard that starts (or restarts) after the pipeline would show an empty
 * feed for a long time. The pipeline saves every headline as it arrives and every answer once
 * its outcome is known, so the recent ones are put back from those files.
 */
function restoreNews() {
  try {
    const itemsFile = newest('items-', ITEMS_DIR);
    if (!itemsFile) return;
    const items = parseLines<NewsItem>(tailLines(join(ITEMS_DIR, itemsFile), 512 * 1024)).slice(-150);
    const recordsFile = newest('news-');
    const records = recordsFile ? parseLines<NewsRecord>(tailLines(join(DECISIONS_DIR, recordsFile))) : [];
    const key = (id: string, recvTs: number) => `${id}|${recvTs}`;
    const byItem = new Map<string, NewsRecord[]>();
    for (const r of records) byItem.set(key(r.item.id, r.item.recvTs), [...(byItem.get(key(r.item.id, r.item.recvTs)) ?? []), r]);
    for (const item of items) publish({ type: 'news-restored', program: 'news', entry: restoredEntry(item, byItem.get(key(item.id, item.recvTs)) ?? []) });
    if (items.length > 0) log(`restored ${items.length} recent headlines from ${itemsFile}`);
  } catch (error) {
    log(`restoring recent news: ${(error as Error).message}`);
  }
}

/** Complete lines added to the newest file since the last look. */
function readNew(tail: Tail): string[] {
  const file = newest(tail.prefix);
  if (!file) return [];
  const path = join(DECISIONS_DIR, file);
  const size = statSync(path).size;
  let midLine = false;
  if (file !== tail.file) {
    const offset = Math.max(0, size - BACKFILL_BYTES);
    Object.assign(tail, { file, offset, partial: '' });
    midLine = offset > 0; // we are starting somewhere inside a record
  }
  if (size <= tail.offset) return [];
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - tail.offset);
    readSync(fd, buf, 0, buf.length, tail.offset);
    tail.offset = size;
    const lines = (tail.partial + buf.toString()).split('\n');
    tail.partial = lines.pop() ?? ''; // the last piece may be a record still being written
    if (midLine) lines.shift();
    return lines.filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

function followRecords() {
  try {
    const before = tails.live.file;
    const fresh = parseLines<DecisionRecord>(readNew(tails.live));
    // Each run of the pipeline writes its own file, and the scoreboard is about one run. Clearing
    // it counts as news in itself: a new run takes a minute to finish its first decision, and
    // until then the last run's numbers would sit there looking like this one's.
    if (tails.live.file !== before) {
      scored = [];
      leans = new LeanBook();
      scoreDirty = true;
    }
    for (const rec of fillLeans(fresh, leans)) {
      publish(liveOutcome(rec));
      scored.push(rec);
      scoreDirty = true;
    }
    if (scored.length > SCORE_WINDOW) scored = scored.slice(-SCORE_WINDOW);
    const finished = parseLines<NewsRecord>(readNew(tails.news));
    // A headline from before the dashboard started gets its answer here, once its record is saved.
    const byItem = Map.groupBy(finished, r => `${r.item.id}|${r.item.recvTs}`);
    for (const recs of byItem.values()) publish({ type: 'news-restored', program: 'news', entry: restoredEntry(recs[0]!.item, recs) });
    for (const rec of finished) publish(newsOutcome(rec, MAX_SPREAD_BPS));
    const aboutTraded = finished.filter(r => r.symbol === config.product);
    if (aboutTraded.length > 0) {
      // Sorted so the strategy's "most recent headline" lookup can stop at the first match: two
      // model calls can finish a moment out of order, even though they were logged close together.
      newsForPnl = [...newsForPnl, ...aboutTraded].sort((a, b) => a.tResp - b.tResp).slice(-NEWS_FOR_PNL_LIMIT);
      scoreDirty = true; // a new headline can change what the selective rule would have done
    }
    if (scoreDirty) {
      scoreDirty = false;
      publish({ type: 'scoreboard', program: 'live', board: scoreboard(scored) });
      publish({ type: 'pnl', program: 'live', pnl: pnlReport(scored, { feeBpsPerSide: config.feeBpsPerSide, notionalUsd: NOTIONAL_USD, product: config.product }, newsForPnl) });
    }
  } catch (error) {
    log(`reading finished records: ${(error as Error).message}`);
  }
}
restoreNews(); // before following records, so their outcomes find the headlines they belong to
followRecords();
setInterval(followRecords, 2000);

// ---- the page --------------------------------------------------------------------------------

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ts': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const stripped = new Map<string, { mtimeMs: number; js: string }>();

/**
 * The page's code is TypeScript like everything else. Browsers cannot run that, so it is served
 * with the types blanked out (Node can do this itself), which needs no build step and keeps line
 * numbers the same as in the source.
 */
function javascript(path: string): string {
  const { mtimeMs } = statSync(path);
  const hit = stripped.get(path);
  if (hit?.mtimeMs === mtimeMs) return hit.js;
  const js = stripTypeScriptTypes(readFileSync(path, 'utf8'));
  stripped.set(path, { mtimeMs, js });
  return js;
}

/** Only the page's own files and the state logic it shares with this server may be served. */
function servable(urlPath: string): string | undefined {
  if (urlPath === '/') return join(HERE, 'web', 'index.html');
  if (!urlPath.startsWith('/d/')) return undefined;
  const path = normalize(join(HERE, urlPath.slice(3)));
  const allowed = path.startsWith(join(HERE, 'web') + sep) || path === join(HERE, 'collector.ts');
  return allowed && TYPES[extname(path)] && existsSync(path) ? path : undefined;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET') return void res.writeHead(405).end();

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify(state.snapshot(Date.now())));
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify({ received, rejected, browsers: clients.size, seq }));
  }

  const path = servable(url.pathname);
  if (!path) return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  try {
    const ext = extname(path);
    res.writeHead(200, { 'Content-Type': TYPES[ext]!, 'Cache-Control': 'no-store' });
    res.end(ext === '.ts' ? javascript(path) : readFileSync(path));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String((error as Error).message));
  }
});

server.listen(HTTP_PORT, HOST, () => {
  log(`dashboard: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${HTTP_PORT}   listening for telemetry on udp://${HOST}:${UDP_PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') log('reachable from other machines: there is no password, so only do this on a network you trust');
});
