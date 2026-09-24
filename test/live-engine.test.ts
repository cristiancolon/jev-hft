import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { config } from '../src/config.ts';
import { LiveEngine, type DecisionRecord } from '../src/engine.ts';
import { nowMs, type MarketEvent } from '../src/feed/types.ts';
import type { TelemetryBody } from '../src/telemetry/events.ts';
import { scriptedModel, settle, type Step } from './helpers.ts';

const defaults = { warmupMs: config.warmupMs, minIntervalMs: config.minIntervalMs, maxInFlight: config.maxInFlight, flatSigmas: config.flatSigmas };
afterEach(() => Object.assign(config, defaults));

// Every event replaces the whole book, so the mid is exactly what the test says.
const book = (t: number, mid: number, _first = false): MarketEvent => ({
  type: 'book',
  snapshot: true,
  updates: [
    { side: 'bid', price: mid - 0.5, size: 2 },
    { side: 'ask', price: mid + 0.5, size: 1 },
  ],
  exchTs: t - 40,
  recvTs: t,
});

function setup(script: Step[] = []) {
  const { model, calls } = scriptedModel(script);
  const written: DecisionRecord[] = [];
  const logs: string[] = [];
  const told: TelemetryBody[] = []; // what the dashboard would be told
  const engine = new LiveEngine(model, r => written.push(r), s => logs.push(s), e => told.push(e));
  return { engine, calls, written, logs, told };
}

test('no question is asked until the history windows have had time to fill', async () => {
  Object.assign(config, { warmupMs: 60_000, minIntervalMs: 0 });
  const s = setup();
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  s.engine.onEvent(book(t + 59_000, 100));
  await settle();
  assert.equal(s.calls.length, 0);
  s.engine.onEvent(book(t + 60_000, 100));
  await settle();
  assert.equal(s.calls.length, 1);
});

test('a decision is recorded with what was asked, what was answered, simple rules, and later prices', async () => {
  Object.assign(config, { warmupMs: 0, minIntervalMs: 3_600_000 });
  const s = setup();
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.written.length, 0, 'held until its last horizon');
  s.engine.onEvent(book(t + 30_000, 101));
  s.engine.onEvent(book(t + 59_000, 102));
  assert.equal(s.written.length, 0);
  s.engine.onEvent(book(t + 61_000, 103));
  assert.equal(s.written.length, 1);
  const r = s.written[0]!;
  assert.equal(r.v, 2);
  assert.equal(r.mode, 'live');
  assert.deepEqual(r.flatBps, { dir_2s: 0.5, dir_10s: 1, dir_60s: 3 }, 'volatility is not known yet, so the fixed thresholds were asked');
  assert.deepEqual(r.probabilities.dir_10s, { up: 0.8, down: 0.1, flat: 0.1 });
  assert.ok(Math.abs(r.signals.jev_10s! - 0.7) < 1e-12);
  assert.ok(Math.abs(r.signals.obi1! - 1 / 3) < 1e-12, 'book imbalance: (2 - 1) / (2 + 1)');
  assert.equal(r.midState, 100);
  assert.equal(r.fwdResp[1], 100);
  assert.equal(r.fwdState[30], 101, 'the price 30 s after the snapshot');
  assert.equal(r.fwdState[60], 102, 'the last price known by then (the move to 103 came at 61 s)');
  assert.ok(r.tResp >= r.tState);
  assert.equal(r.costUsd, 0.000025);
  assert.equal(r.providerMs, 120);
  assert.match(r.state, /^BTC-USD \d\d:\d\d UTC mid 100\.00/);
  // What trading it would have cost, and what the order-book model expected (src/model/ridge.ts).
  assert.deepEqual(r.quote, { bid: 99.5, ask: 100.5 });
  assert.deepEqual(r.quoteResp, { bid: 99.5, ask: 100.5 }, 'nothing moved while Jev answered');
  assert.ok(Number.isFinite(r.signals.ob_10s) && Number.isFinite(r.signals.ob_60s));
  assert.ok('vol60' in r, 'volatility is saved (unknown this early, so NaN)');
});

test("each answer is read against the ones before it, once there are enough of them", async () => {
  Object.assign(config, { warmupMs: 0, minIntervalMs: 1000 });
  const s = setup();
  const t = nowMs();
  // The scripted model always answers up 0.8 / down 0.1, so its usual lean settles at +0.7.
  for (let i = 0; i <= 61; i++) {
    s.engine.onEvent(book(t + i * 1000, 100, i === 0));
    await settle();
  }
  s.engine.flush(Infinity, true);
  assert.equal(s.written.length, 62);
  const first = s.written[0]!;
  assert.ok(Number.isNaN(first.lean!.dir_10s.usual), 'nothing to read the first answer against');
  assert.ok(Number.isNaN(first.signals.jevc_10s));
  assert.ok(Math.abs(first.signals.jev_10s! - 0.7) < 1e-12, 'the answer itself is recorded as before');
  assert.ok(Number.isNaN(s.written[59]!.signals.jevc_10s), 'one answer short of enough');
  const later = s.written[60]!;
  assert.ok(Math.abs(later.lean!.dir_10s.usual - 0.7) < 1e-12);
  assert.ok(Math.abs(later.signals.jevc_10s!) < 1e-12, 'an answer that is exactly the usual one is no lean at all');
  const told = s.told.filter(e => e.type === 'answer');
  assert.deepEqual(told[60]!.type === 'answer' && told[60]!.lean, later.lean, 'and the dashboard is told the same');
  assert.equal(JSON.parse(JSON.stringify(first)).signals.jevc_10s, null, 'saved as "unknown", not as zero');
});

test('decisions keep their spacing, and one at a time', async () => {
  Object.assign(config, { warmupMs: 0, minIntervalMs: 1000 });
  const s = setup();
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  await settle();
  s.engine.onEvent(book(t + 100, 100));
  s.engine.onEvent(book(t + 900, 100));
  await settle();
  assert.equal(s.calls.length, 1);
  s.engine.onEvent(book(t + 1000, 100));
  await settle();
  assert.equal(s.calls.length, 2);
});

test('after a rate-limit refusal the loop pauses instead of hammering', async () => {
  Object.assign(config, { warmupMs: 0, minIntervalMs: 0 });
  const s = setup(['rate-limit']);
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  await settle();
  s.engine.onEvent(book(t + 1000, 100));
  await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.engine.stats.rateLimited, 1);
  assert.match(s.logs.join('\n'), /pausing decisions 5s/);
});

test('out of credits, the loop waits minutes before asking again, not a second', async () => {
  Object.assign(config, { warmupMs: 0, minIntervalMs: 0 });
  const s = setup(['out-of-credits']);
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  await settle();
  for (const later of [1000, 30_000, 59_000]) {
    s.engine.onEvent(book(t + later, 100));
    await settle();
  }
  assert.equal(s.calls.length, 1, 'no second call within the first minute');
  assert.equal(s.engine.stats.outOfCredits, 1);
  assert.equal(s.engine.stats.errors, 0, 'counted apart from other errors');
  assert.match(s.logs.join('\n'), /out of credits; asking again in 1 min/);
  s.engine.onEvent(book(t + 61_000, 100));
  await settle();
  assert.equal(s.calls.length, 2, 'asks again once the pause is over');
});

test('a broken feed stops decisions until the book is rebuilt and warmed up again', async () => {
  Object.assign(config, { warmupMs: 10_000, minIntervalMs: 0 });
  const s = setup();
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  s.engine.onEvent({ type: 'reset', recvTs: t + 5000 });
  s.engine.onEvent(book(t + 6000, 100, true));
  s.engine.onEvent(book(t + 15_000, 100));
  await settle();
  assert.equal(s.calls.length, 0, 'only 9 s since the book came back');
  s.engine.onEvent(book(t + 16_000, 100));
  await settle();
  assert.equal(s.calls.length, 1);
});

test('the dashboard is told about each question and what came of it', async () => {
  Object.assign(config, { warmupMs: 0, minIntervalMs: 1000 });
  const s = setup(['ok', 'rate-limit']);
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  await settle();
  s.engine.onEvent(book(t + 1000, 101));
  await settle();

  assert.deepEqual(s.told.map(e => `${e.type}:${'id' in e ? e.id : ''}`), ['ask:1', 'answer:1', 'ask:2', 'fail:2']);
  const [ask, answer, , fail] = s.told as [TelemetryBody, TelemetryBody, TelemetryBody, TelemetryBody];
  assert.ok(ask.type === 'ask' && answer.type === 'answer' && fail.type === 'fail');
  assert.match(ask.state, /^BTC-USD/, 'exactly the text Jev was sent');
  assert.deepEqual(ask.flatBps, { dir_2s: 0.5, dir_10s: 1, dir_60s: 3 });
  assert.equal(ask.features.mid, 100);
  assert.ok(Math.abs(answer.signals.jev_10s! - 0.7) < 1e-12);
  assert.deepEqual([answer.providerMs, answer.costUsd, answer.midResp], [120, 0.000025, 100]);
  assert.equal(fail.kind, 'rate-limit');
  // Telemetry describes the decision; it is not a second copy of the record, which is written as before.
  s.engine.flush(Infinity, true);
  assert.equal(s.written.length, 1);
});

test('an engine nobody is watching behaves exactly the same', async () => {
  Object.assign(config, { warmupMs: 0, minIntervalMs: 3_600_000 }); // one question, then quiet, so the test can end
  const { model } = scriptedModel();
  const written: DecisionRecord[] = [];
  const engine = new LiveEngine(model, r => written.push(r), () => {}); // no emit given
  engine.onEvent(book(nowMs(), 100, true));
  await settle();
  engine.flush(Infinity, true);
  assert.equal(written.length, 1);
});
