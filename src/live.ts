// Live paper pipeline: Coinbase feed -> state -> Jev -> decision log. No orders are sent.
//
//   npm run live                                   # gateway, run until Ctrl-C
//   JEV_PROVIDER=mock RUN_MINUTES=5 npm run live   # full pipeline, simulated model
//   RECORD=1 npm run live                          # also save the market data for replay

import { mkdirSync, createWriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { config } from './config.ts';
import { coinbaseFeed } from './feed/coinbase.ts';
import { recorder } from './feed/recorder.ts';
import { LiveEngine } from './engine.ts';
import { fileStamp, log, onStop } from './lib/run.ts';
import { summarize } from './lib/stats.ts';
import { createModel, keepWarm } from './model/jev.ts';
import { parseTarget, telemetrySender } from './telemetry/sender.ts';

mkdirSync('data/decisions', { recursive: true });
const file = `data/decisions/live-${config.provider}-${fileStamp()}.jsonl`;
const out = createWriteStream(file);

// What the dashboard sees. Fire-and-forget: the pipeline never waits for it (docs/dashboard.md).
const target = parseTarget(process.env.TELEMETRY);
const telemetry = telemetrySender('live', target);

const engine = new LiveEngine(createModel(config.provider), r => out.write(JSON.stringify(r) + '\n'), log, telemetry.emit);
// RECORD=1: save the events this run sees, so the exact same run can be replayed later.
const rec = config.record ? recorder(config.product) : undefined;
const stopWarm = keepWarm(config.provider, log); // matters when decisions are more than a few seconds apart

// Per-window measurements of the data side: feed lag and event processing cost.
let events = 0;
let lags: number[] = [];
let applyUs: number[] = [];

const feed = coinbaseFeed(
  config.product,
  e => {
    const t0 = performance.now();
    rec?.write(e); // inside the timing, so "event cost" stays the true cost per event
    engine.onEvent(e);
    applyUs.push((performance.now() - t0) * 1000);
    events++;
    if (e.type !== 'reset') lags.push(e.recvTs - e.exchTs);
  },
  log,
);

log(
  `live ${config.product} provider=${config.provider} encoding=${config.encoding} warmup=${config.warmupMs / 1000}s ` +
    `spacing>=${config.minIntervalMs}ms flat=${config.flatSigmas > 0 ? `${config.flatSigmas} x typical move` : 'fixed'} -> ${file}` +
    (rec ? `\nalso recording market data -> ${rec.file}` : '') +
    (target ? `\ndashboard telemetry -> udp://${target.host}:${target.port} (npm run dashboard to watch; TELEMETRY=0 turns it off)` : ''),
);

// Once a second, tell the dashboard we are alive and what the numbers are. Everything here is
// read from values that exist anyway; nothing is added to the handling of a market update.
let eventCost: { p50: number; p99: number } | null = null;
let seenEvents = 0;
let seenLags = 0;
const pulse = target
  ? setInterval(() => {
      if (events < seenEvents) seenEvents = 0; // the status window below was just reset
      if (lags.length < seenLags) seenLags = 0;
      const recent = lags.slice(seenLags).sort((a, b) => a - b);
      const { book, ready } = engine.state;
      const s = engine.stats;
      telemetry.emit({
        type: 'pulse',
        program: 'live',
        meta: { provider: config.provider, product: config.product, minIntervalMs: config.minIntervalMs, flatSigmas: config.flatSigmas, warmupMs: config.warmupMs, recording: rec !== undefined },
        market: ready ? { ready, mid: book.mid, bid: book.bestBid, ask: book.bestAsk } : { ready, mid: null, bid: null, ask: null },
        stats: { decisions: s.decisions, written: s.written, rateLimited: s.rateLimited, timeouts: s.timeouts, errors: s.errors, costUsd: s.costUsd },
        feed: { eventsPerS: events - seenEvents, lagMs: recent.length > 0 ? recent[recent.length >> 1]! : null },
        eventCostUs: eventCost,
      });
      seenEvents = events;
      seenLags = lags.length;
    }, 1000)
  : undefined;

const STATUS_MS = 10_000;
const status = setInterval(() => {
  const s = engine.stats;
  const lag = summarize(lags);
  const ap = summarize(applyUs);
  eventCost = { p50: ap.p50, p99: ap.p99 };
  log(
    `mid ${engine.state.book.mid.toFixed(2)}  ev/s ${(events / (STATUS_MS / 1000)).toFixed(0)}  feed lag p50 ${lag.p50.toFixed(0)}ms  ` +
      `event cost p50 ${ap.p50.toFixed(0)}µs p99 ${ap.p99.toFixed(0)}µs  decisions ${s.decisions}  written ${s.written}  ` +
      `model ${Number.isFinite(s.lastModelMs) ? s.lastModelMs.toFixed(0) + 'ms' : '-'}  429s ${s.rateLimited}  timeouts ${s.timeouts}  errors ${s.errors}  no-credit ${s.outOfCredits}  cost $${s.costUsd.toFixed(4)}`,
  );
  events = 0;
  lags = [];
  applyUs = [];
}, STATUS_MS);

onStop(() => {
  clearInterval(status);
  clearInterval(pulse);
  telemetry.close();
  stopWarm();
  feed.close();
  engine.flush(Infinity, true); // horizons that have not elapsed are recorded as unknown
  const decisions = new Promise<void>(resolve => out.end(resolve));
  void Promise.all([decisions, rec?.close()]).then(() => {
    log(`wrote ${engine.stats.written} decisions to ${file}` + (rec ? `, ${rec.events} events to ${rec.file}` : ''));
    process.exit(0);
  });
}, config.runMs);
