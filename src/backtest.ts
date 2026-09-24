// Offline evaluation on recorded data. Replays events, snapshots the state every
// STEP_S seconds, asks Jev about each snapshot (in parallel: offline there is no
// latency budget), then scores answers as if they arrived BT_LATENCY_MS later.
// Separates "does Jev see anything?" from "can we act on it in time?".
//
// Every answer is saved in data/cache/jev-answers.jsonl, keyed by exactly what Jev was shown.
// Running again on the same recording (to try another BT_LATENCY_MS, or to finish a run that
// was interrupted) reuses those answers instead of paying for them again.
//
//   npm run backtest -- data/raw/BTC-USD-<ts>.jsonl.gz
//   STEP_S=2 BT_LATENCY_MS=375 BT_CONCURRENCY=8 BT_MAX=2000 npm run backtest -- <file>

import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { config, envNum } from './config.ts';
import { answerFields, bookFields, fillForward, type DecisionRecord } from './engine.ts';
import type { MarketEvent } from './feed/types.ts';
import { fileStamp } from './lib/run.ts';
import { encode } from './market/encode.ts';
import { replayer } from './market/replay.ts';
import { MarketState, type Features } from './market/state.ts';
import { closeConnections, createModel, decide, flatThresholds, isTransient, RateLimitedError, type FlatThresholds, type ModelResult } from './model/jev.ts';
import { fillLeans } from './model/lean.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: npm run backtest -- <recorded .jsonl[.gz]>');

const stepMs = envNum('STEP_S', 5, { min: 0.01 }) * 1000;
const latencyMs = envNum('BT_LATENCY_MS', 375, { min: 0 });
const concurrency = envNum('BT_CONCURRENCY', 4, { min: 1 });
const maxSnapshots = envNum('BT_MAX', Infinity, { min: 1 });
/** Measured on live runs: about 230 tokens of fixed overhead, the state, and three questions. */
const TOKENS_PER_DECISION = 855;
const USD_PER_TOKEN = 0.042 / 1e6;

// 1. Replay and snapshot. Each snapshot sees only events received before its time.
type Snapshot = { tState: number; f: Features; text: string; flat: FlatThresholds; buildMs: number; book: ReturnType<typeof bookFields> };
const state = new MarketState(Infinity);
let snaps: Snapshot[] = [];
const feed = replayer(state, stepMs, config.warmupMs, t => {
  const t0 = performance.now();
  const f = state.features(t);
  const text = encode(f, state, config.product, config.encoding);
  const buildMs = performance.now() - t0; // what a live run spends before asking, so the order-book model is left out of it
  snaps.push({ tState: t, f, text, flat: flatThresholds(f.vol60, config.flatSigmas), buildMs, book: bookFields(f, state) });
});

const input = createReadStream(file).pipe(file.endsWith('.gz') ? createGunzip() : new PassThrough());
for await (const line of createInterface({ input, crlfDelay: Infinity })) if (line) feed(JSON.parse(line) as MarketEvent);
const total = snaps.length;
if (snaps.length > maxSnapshots) {
  const stride = snaps.length / maxSnapshots;
  snaps = Array.from({ length: maxSnapshots }, (_, i) => snaps[Math.floor(i * stride)]!);
}

// 2. Answers already paid for. The mock's answers are random, so they are never kept.
const CACHE_FILE = 'data/cache/jev-answers.jsonl';
const useCache = config.provider !== 'mock' && process.env.BT_CACHE !== '0';
const cache = new Map<string, ModelResult>();
if (useCache && existsSync(CACHE_FILE)) {
  for (const line of readFileSync(CACHE_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    const { key, result } = JSON.parse(line) as { key: string; result: ModelResult };
    cache.set(key, result);
  }
}
const keyOf = (s: Snapshot) => createHash('sha256').update(JSON.stringify([config.provider, process.env.AI_GATEWAY_MODEL ?? '', s.text, s.flat])).digest('hex');
const cached = snaps.filter(s => cache.has(keyOf(s))).length;
const toAsk = snaps.length - cached;
console.error(
  `replayed ${file}: ${total} snapshots every ${stepMs / 1000}s, evaluating ${snaps.length} with ${config.provider}` +
    (useCache ? `; ${cached} already answered in ${CACHE_FILE}` : '') +
    (config.provider === 'mock' ? '' : `; about $${(toAsk * TOKENS_PER_DECISION * USD_PER_TOKEN).toFixed(4)} for ${toAsk} new calls at list price`),
);

// 3. Evaluate with bounded concurrency; wait out rate limits rather than dropping snapshots.
const model = createModel(config.provider);
const records: DecisionRecord[] = [];
let cursor = 0;
let rateLimited = 0;
let retried = 0;
let failed = 0;
let spentUsd = 0;

async function answer(s: Snapshot): Promise<ModelResult> {
  const key = keyOf(s);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = await decide(model, s.text, s.flat, AbortSignal.timeout(30_000)); // a stuck call must not hang a worker
  spentUsd += result.meta.costUsd ?? 0;
  if (useCache) {
    mkdirSync('data/cache', { recursive: true });
    appendFileSync(CACHE_FILE, JSON.stringify({ key, result }) + '\n');
    cache.set(key, result);
  }
  return result;
}

async function worker() {
  while (cursor < snaps.length) {
    const s = snaps[cursor++]!;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await answer(s);
        const answered = answerFields(res, s.f, s.flat);
        const rec: DecisionRecord = {
          v: 2,
          mode: 'backtest',
          provider: config.provider,
          tState: s.tState,
          exchLagMs: s.tState - s.f.exchTs,
          buildMs: s.buildMs,
          modelMs: latencyMs,
          tResp: s.tState + latencyMs,
          state: s.text,
          ...answered,
          // Only mids are kept for later times, so a backtest charges the spread at the snapshot.
          signals: { ...answered.signals, ...s.book.signals },
          quote: s.book.quote,
          vol60: s.book.vol60,
          midState: s.f.mid,
          midResp: state.midAt(s.tState + latencyMs),
          fwdState: {},
          fwdResp: {},
        };
        delete rec.providerMs; // modelMs is simulated here, so a measured part of it would mislead
        fillForward(rec, state);
        records.push(rec);
        if (records.length % 50 === 0) console.error(`  ${records.length}/${snaps.length} evaluated`);
        break;
      } catch (error) {
        if (error instanceof RateLimitedError && attempt < 30) {
          rateLimited++;
          await new Promise(r => setTimeout(r, Math.min(5000 * 2 ** attempt, 60_000)));
          continue;
        }
        // A timeout or a hiccup on the server's side: worth a couple more tries, since a gap in
        // the results is worse here than a delay.
        if (!(error instanceof RateLimitedError) && isTransient(error) && attempt < 3) {
          retried++;
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        failed++;
        console.error(`  snapshot ${new Date(s.tState).toISOString()} failed: ${(error as Error).message}`);
        break;
      }
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

mkdirSync('data/decisions', { recursive: true });
const outFile = `data/decisions/backtest-${config.provider}-${fileStamp()}.jsonl`;
const out = createWriteStream(outFile);
// Answers came back in whatever order they finished. Each is read against the ones before it,
// as a live run would have, so that has to wait until they are back in order.
for (const r of fillLeans(records.sort((a, b) => a.tState - b.tState))) out.write(JSON.stringify(r) + '\n');
out.end(() => {
  console.error(`wrote ${records.length} decisions (${failed} failed, ${retried} retried, ${rateLimited} rate-limit waits, $${spentUsd.toFixed(4)} of new calls at list price) to ${outFile}`);
  void closeConnections();
});
