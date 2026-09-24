// Replays a recording and writes one row of measurements a second, for research/fit.py.
//
//   node research/extract.ts data/raw/BTC-USD-<ts>.jsonl.gz [out-prefix]
//
// Each row holds what the live engine could have known at that second (MarketState's features
// and src/market/microstructure.ts, the same code a live run uses), followed by the best bid and
// ask at the moments an order could have been placed and closed. Entry is looked up 0, 300 and
// 1000 ms after the snapshot, and the exit 10 and 60 seconds after the entry, so the fits can be
// scored on prices that were actually tradable, with the spread paid, and with a realistic delay.
//
// Writes <out-prefix>.f64 (rows of float64) and <out-prefix>.json (column names). A price is NaN
// when the book was broken at that moment, or broke at any point between snapshot and exit.

import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { MarketEvent } from '../src/feed/types.ts';
import { Microstructure } from '../src/market/microstructure.ts';
import { replayer } from '../src/market/replay.ts';
import { MarketState } from '../src/market/state.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: node research/extract.ts <recording.jsonl.gz> [out-prefix]');
const prefix = process.argv[3] ?? 'data/research/rows';

const STEP_MS = 1000;
const WARMUP_MS = 60_000;
const ENTRY_DELAYS_MS = [0, 300, 1000];
const HORIZONS_S = [10, 60];

const BASE = ['bid', 'ask', 'mid', 'spreadBps', 'microBps', 'imb1', 'imb5', 'imb20', 'depthBid10', 'depthAsk10', 'ret1', 'ret5', 'ret30', 'ret60', 'vol60', 'flow1', 'flow5', 'flow30', 'trades5', 'buys5', 'sells5'] as const;

const state = new MarketState();
const micro = new Microstructure(state);

let columns: string[] | undefined;
const rows: Float64Array[] = [];
/** A price to look up later: when, which row, and the column its bid goes in (the ask goes next to it). */
type Target = { t: number; row: Float64Array; col: number; resets: number };
/** One queue per (entry delay, horizon): each is in time order, so only its head needs checking. */
const queues = new Map<string, Target[]>();
let resets = 0;

function labelColumns() {
  const cols: string[] = [];
  for (const d of ENTRY_DELAYS_MS) {
    cols.push(`entryBid_${d}`, `entryAsk_${d}`);
    for (const h of HORIZONS_S) cols.push(`exitBid_${d}_${h}`, `exitAsk_${d}_${h}`);
  }
  return cols;
}

function capture(now: number) {
  for (const q of queues.values()) {
    while (q.length > 0 && q[0]!.t <= now) {
      const x = q.shift()!;
      const ok = state.ready && x.resets === resets;
      x.row[x.col] = ok ? state.book.bestBid : NaN;
      x.row[x.col + 1] = ok ? state.book.bestAsk : NaN;
    }
  }
}

function later(name: string, t: number, row: Float64Array) {
  let q = queues.get(name);
  if (!q) queues.set(name, (q = []));
  q.push({ t, row, col: columns!.indexOf(name), resets });
}

const feed = replayer(state, STEP_MS, WARMUP_MS, t => {
  const f = state.features(t);
  const m = micro.read(t);
  columns ??= ['t', ...BASE, 'maxTradeSigned5', ...Object.keys(m), ...labelColumns()];
  const row = new Float64Array(columns.length).fill(NaN);
  let i = 0;
  row[i++] = t;
  for (const k of BASE) row[i++] = f[k];
  row[i++] = f.maxTradeSide5 === 'sell' ? -f.maxTrade5 : f.maxTrade5;
  for (const v of Object.values(m)) row[i++] = v;
  for (const d of ENTRY_DELAYS_MS) {
    later(`entryBid_${d}`, t + d, row);
    for (const h of HORIZONS_S) later(`exitBid_${d}_${h}`, t + d + h * 1000, row);
  }
  rows.push(row);
});

const input = createReadStream(file).pipe(file.endsWith('.gz') ? createGunzip() : new PassThrough());
let n = 0;
try {
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line) continue;
    let e: MarketEvent;
    try {
      e = JSON.parse(line) as MarketEvent;
    } catch {
      break; // a recording still being written ends mid-line
    }
    capture(e.recvTs); // before the event: the price "at t" is what was known just before t
    if (e.type === 'reset') resets++;
    feed(e);
    micro.apply(e);
    if (++n % 2_000_000 === 0) console.error(`  ${n} events, ${rows.length} rows, ${new Date(e.recvTs).toISOString()}`);
  }
} catch (error) {
  console.error(`stopped reading at event ${n}: ${(error as Error).message} (a copy of a file still being written ends mid-stream)`);
}

// Rows whose exit had not happened by the end of the recording keep NaN prices.
if (!columns) throw new Error('no rows: the recording is shorter than the warm-up');
mkdirSync(dirname(prefix), { recursive: true });
const out = createWriteStream(`${prefix}.f64`);
for (const r of rows) out.write(Buffer.from(r.buffer));
out.end(() => {
  writeFileSync(`${prefix}.json`, JSON.stringify({ source: file, stepMs: STEP_MS, entryDelaysMs: ENTRY_DELAYS_MS, horizonsS: HORIZONS_S, rows: rows.length, columns }, null, 1));
  console.error(`wrote ${rows.length} rows x ${columns!.length} columns from ${n} events to ${prefix}.f64`);
});
