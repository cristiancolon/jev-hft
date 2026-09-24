import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HeadlineBook } from '../src/dashboard/headlines.ts';
import type { NewsRecord } from '../src/news/engine.ts';
import { expectedMoveBps } from '../src/news/questions.ts';

const T0 = 1_800_000_000_000;

/** The telemetry for one answered item: a verdict per instrument, BTC-USD's at a price of 100 unless given. */
function answer(id: string, tResp: number, verdicts: { symbol: string; signal: number; mid?: number | null }[]) {
  return {
    id,
    tResp,
    verdicts: verdicts.map(v => ({
      symbol: v.symbol, name: v.symbol, relevant: 0.9, direction: { bullish: 0.8, bearish: 0.1 }, magnitude: 2, signal: v.signal,
      mid: v.mid === undefined ? 100 : v.mid, spreadBps: 0.5,
    })),
  };
}

function saved(id: string, tResp: number, over: Partial<NewsRecord> = {}): NewsRecord {
  return {
    v: 2, kind: 'news', provider: 'test',
    item: { id, source: 'wire', headline: 'x', recvTs: tResp - 300, symbols: ['BTC-USD'] },
    symbol: 'BTC-USD', assetClass: 'crypto', session: 'regular', tracked: true, spreadBps: 0.5, queueMs: 0, prepareMs: 0,
    tState: tResp - 200, buildMs: 0, modelMs: 200, tResp, instruments: 1, state: {} as NewsRecord['state'],
    relevant: 0.9, direction: {}, magnitude: 2, magnitudeProbs: {}, novel: 0.5, signal: 0.7,
    midPublished: NaN, midRecv: 100, midResp: 100, fwdRecv: {}, fwdResp: { 60: 100.2, 300: 100.4, 1800: 100.6 },
    ...over,
  };
}

/** One tick a second from `fromS` to `toS` seconds after T0, the price rising a cent a second from 100. */
const ticks = (fromS: number, toS: number) => Array.from({ length: toS - fromS + 1 }, (_, k) => ({ t: T0 + (fromS + k) * 1000, mid: 100 + (fromS + k) / 100 }));

test('a verdict counts the moment it is answered, only for the traded instrument', () => {
  const book = new HeadlineBook('BTC-USD', 10);
  assert.equal(book.answered(answer('a', T0, [{ symbol: 'SPY', signal: 0.5 }, { symbol: 'BTC-USD', signal: -0.4 }])), true);
  assert.deepEqual(book.list().map(h => [h.symbol, h.signal, h.midResp, h.saved]), [['BTC-USD', -0.4, 100, false]]);
  assert.equal(book.answered(answer('a', T0, [{ symbol: 'BTC-USD', signal: -0.4 }])), false, 'the same answer twice is one headline');
  assert.equal(book.answered(answer('b', T0, [{ symbol: 'BTC-USD', signal: 0.4, mid: null }])), false, 'no price to trade at');
});

test('each check is filled in from the ticks once it comes due, and not before', () => {
  const book = new HeadlineBook('BTC-USD', 10);
  book.answered(answer('a', T0, [{ symbol: 'BTC-USD', signal: 0.5 }]));
  assert.equal(book.settle(ticks(0, 59), [60, 300]), false, 'a minute has not passed');
  assert.equal(book.settle(ticks(0, 61), [60, 300]), true);
  assert.equal(book.list()[0]!.fwdResp[60], 100.6);
  assert.equal(book.list()[0]!.fwdResp[300], undefined);
});

test('a gap in the ticks is not a price', () => {
  const book = new HeadlineBook('BTC-USD', 10);
  book.answered(answer('a', T0, [{ symbol: 'BTC-USD', signal: 0.5 }]));
  const gappy = [...ticks(0, 50), ...ticks(70, 80)]; // paused over the one-minute mark
  assert.equal(book.settle(gappy, [60]), false);
  assert.equal(book.list()[0]!.fwdResp[60], undefined);
});

test('the saved record replaces the verdict, and its exact prices are never overwritten by ticks', () => {
  const book = new HeadlineBook('BTC-USD', 10);
  book.answered(answer('a', T0, [{ symbol: 'BTC-USD', signal: 0.5 }]));
  book.settle(ticks(0, 61), [60]);
  assert.equal(book.saved(saved('a', T0)), true);
  assert.equal(book.list().length, 1, 'one headline, not two');
  assert.equal(book.list()[0]!.saved, true);
  assert.equal(book.list()[0]!.signal, 0.7);
  book.settle(ticks(0, 400), [60, 300]);
  assert.deepEqual(book.list()[0]!.fwdResp, { 60: 100.2, 300: 100.4, 1800: 100.6 });
  assert.equal(book.saved(saved('a', T0)), false, 'read twice, it changes nothing');
});

test('a saved record about another instrument, or from before magnitudes were asked, is left out', () => {
  const book = new HeadlineBook('BTC-USD', 10);
  assert.equal(book.saved(saved('a', T0, { symbol: 'AAPL' })), false);
  assert.equal(book.saved(saved('b', T0, { magnitude: undefined as unknown as number })), false);
  assert.equal(book.list().length, 0);
});

test('oldest first whatever order they arrive in, and only the newest are kept', () => {
  const book = new HeadlineBook('BTC-USD', 2);
  book.saved(saved('c', T0 + 3000));
  book.answered(answer('a', T0 + 1000, [{ symbol: 'BTC-USD', signal: 0.1 }]));
  book.saved(saved('b', T0 + 2000));
  assert.deepEqual(book.list().map(h => h.id), ['b', 'c']);
});

test("Jev's magnitude answer reads as a move in bps between its rubric's levels", () => {
  assert.equal(expectedMoveBps('crypto', 1, 0), 0);
  assert.equal(expectedMoveBps('crypto', 1, 1), 10);
  assert.equal(expectedMoveBps('crypto', 1, 1.5), 35);
  assert.equal(expectedMoveBps('crypto', -0.5, 3), 75, 'the size of the lean, whichever way');
  assert.equal(expectedMoveBps('crypto', 1, 7), 150, 'never beyond the top level');
  assert.equal(expectedMoveBps('equity', 1, 2), 125);
});
