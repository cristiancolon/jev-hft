import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { MarketEvent } from '../src/feed/types.ts';
import { bookShape } from '../src/market/microstructure.ts';
import { MarketState } from '../src/market/state.ts';
import { calmEnough, orderBookModels, orderBookSignals, predict, type RidgeModel } from '../src/model/ridge.ts';

const T0 = 1_800_000_000_000;

test('there is a 10 s and a 60 s model, each tested on a day after every day it was fitted on', () => {
  assert.deepEqual(orderBookModels.map(m => m.horizonS), [10, 60]);
  for (const m of orderBookModels) for (const day of m.trainedOn) assert.ok(day < m.testedOn, `${m.horizonS}s: trained on ${day}, tested on ${m.testedOn}`);
});

test('the live code gives exactly the answers the fit gave (research/fit.py saved them with the weights)', () => {
  for (const m of orderBookModels) {
    assert.ok(m.examples.length > 0);
    for (const { inputs, expected } of m.examples) {
      const got = predict(m, Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v ?? NaN])));
      assert.ok(Math.abs(got - expected) < 1e-9, `${m.horizonS}s: ${got} vs ${expected}`);
    }
  }
});

/** A Bitcoin-like book one cent wide, five levels a side, with `bidSize` and `askSize` at every level. */
function btcBook(bidSize: number, askSize: number) {
  const s = new MarketState();
  const updates = [0, 1, 2, 3, 4].flatMap(i => [
    { side: 'bid' as const, price: 84_000 - i * 0.01, size: bidSize },
    { side: 'ask' as const, price: 84_000.01 + i * 0.01, size: askSize },
  ]);
  const e: MarketEvent = { type: 'book', snapshot: true, updates, exchTs: T0, recvTs: T0 };
  s.apply(e);
  return { ...s.features(T0), ...bookShape(s) } as Record<string, unknown>;
}

test('every measurement the models use is one the live engine takes', () => {
  const values = btcBook(1, 2);
  for (const m of orderBookModels) {
    for (const k of m.features) assert.ok(typeof values[k] === 'number' && Number.isFinite(values[k]), `${m.horizonS}s model needs ${k}`);
  }
  assert.deepEqual(Object.keys(orderBookSignals(values)), ['ob_10s', 'ob_60s']);
});

test('at 10 s a book heavier on the bid side expects a rise, and heavier on the ask side a fall', () => {
  assert.ok(orderBookSignals(btcBook(3, 1)).ob_10s! > 0);
  assert.ok(orderBookSignals(btcBook(1, 3)).ob_10s! < 0);
});

/** One input `a`, clipped to [-1, 1], already standardized, with weight 2 and 0.5 on top. */
const toy: RidgeModel = {
  kind: 'ridge', horizonS: 10, features: ['a'], lo: [-1], hi: [1], mean: [0], sd: [1], weights: [2], intercept: 0.5,
  strongCut: {}, calm: { gate: true, vol60Below: 0.6, maxSpreadTicks: 1, tickUsd: 0.01 }, trainedOn: [], testedOn: '', entryMs: 300, examples: [],
};

test('a value outside the training range is clipped to it, and a missing one counts as average', () => {
  assert.equal(predict(toy, { a: 0.25 }), 1);
  assert.equal(predict(toy, { a: 5 }), 2.5, 'clipped to 1');
  assert.equal(predict(toy, { a: -5 }), -1.5);
  assert.equal(predict(toy, {}), 0.5);
  assert.equal(predict(toy, { a: NaN }), 0.5);
  assert.equal(predict(toy, { a: 'up' }), 0.5, 'only numbers count');
});

test('calm means a quiet minute and a one-tick spread, and matters only where the model says so', () => {
  assert.equal(calmEnough(toy, 0.3, 0.01), true);
  assert.equal(calmEnough(toy, 0.7, 0.01), false, 'too volatile');
  assert.equal(calmEnough(toy, 0.3, 0.02), false, 'two ticks wide');
  assert.equal(calmEnough(toy, NaN, 0.01), false, 'unknown volatility is not calm');
  assert.equal(calmEnough(toy, 0.3, undefined), false);
  assert.equal(calmEnough({ ...toy, calm: { ...toy.calm, gate: false } }, 5, 1), true);
});

/** The fee setting as the program would read it with just these variables set. */
function feeWith(env: Record<string, string>): number {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'FEE_BPS' && k !== 'FEE_BPS_PER_SIDE'));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "const { config } = await import('./src/config.ts'); process.stdout.write(String(config.feeBpsPerSide))"], {
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
  return Number(out.trim());
}

test('the fee is set per fill; an old round-trip FEE_BPS still means the same cost', () => {
  assert.equal(feeWith({}), 2, "Binance.US's taker fee by default");
  assert.equal(feeWith({ FEE_BPS_PER_SIDE: '0' }), 0);
  assert.equal(feeWith({ FEE_BPS: '10' }), 5, 'a 10 bp round trip is 5 on each side');
  assert.equal(feeWith({ FEE_BPS: '10', FEE_BPS_PER_SIDE: '2' }), 2, 'the new setting wins');
});
