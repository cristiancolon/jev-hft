import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pnlReport } from '../src/dashboard/pnl.ts';
import type { DecisionRecord } from '../src/engine.ts';
import type { RidgeModel } from '../src/model/ridge.ts';
import type { NewsRecord } from '../src/news/engine.ts';

const T0 = 1_800_000_000_000;
const OPTS = { feeBpsPerSide: 0, notionalUsd: 10_000, product: 'BTC-USD' };

type Extra = {
  /** Jev's usual lean before this answer. Left out, it is 0, so the corrected lean is the answer itself. */
  usual?: number;
  /** How far Jev's leans typically stray from the usual one. */
  typical?: number;
  /** The best level of the order book: above zero is bid-heavy. Left out, it sides with the corrected lean. */
  book?: number;
};

/** A finished decision: Jev answered with a lean of `jev`, and the price then moved `moveBp` over every horizon. */
function decision(i: number, moveBp: number, jev: number, extra: Extra = {}): DecisionRecord {
  const later = 100 * (1 + moveBp / 1e4);
  const fwd = { 1: later, 2: later, 5: later, 10: later, 30: later, 60: later };
  const usual = extra.usual ?? 0;
  const reading = { usual, typical: extra.typical ?? 0.5 };
  const corrected = jev - usual;
  return {
    v: 2, mode: 'live', provider: 'test', tState: T0 + i * 1000, exchLagMs: 90, buildMs: 0.3, modelMs: 260, tResp: T0 + i * 1000 + 260, state: '',
    probabilities: {} as DecisionRecord['probabilities'],
    confidence: { dir_2s: 0.9, dir_10s: 0.9, dir_60s: 0.9 },
    lean: { dir_2s: reading, dir_10s: reading, dir_60s: reading },
    signals: { jev_2s: jev, jev_10s: jev, jev_60s: jev, jevc_2s: corrected, jevc_10s: corrected, jevc_60s: corrected, obi1: extra.book ?? Math.sign(corrected), obi5: 0, flow5: 0, mom5: 0 },
    midState: 100, midResp: 100, fwdState: fwd, fwdResp: fwd,
  };
}

function newsRecord(over: Partial<NewsRecord> = {}): NewsRecord {
  return {
    v: 2, kind: 'news', provider: 'test',
    item: { id: 'wire:1', source: 'wire', sourceLabel: 'A newswire', headline: 'BTC ETF inflows surge', recvTs: T0, symbols: ['BTC-USD'] },
    symbol: 'BTC-USD', assetClass: 'crypto', session: 'regular', tracked: true, spreadBps: 1, queueMs: 5, prepareMs: 50, attempts: 1,
    tState: T0, buildMs: 0.2, modelMs: 290, tResp: T0, instruments: 1, state: {} as NewsRecord['state'],
    relevant: 0.9, direction: { bullish: 0.8, bearish: 0.1, neutral: 0.1 }, magnitude: 2, magnitudeProbs: {}, novel: 0.7, signal: 0.7,
    midPublished: NaN, midRecv: 100, midResp: 100, fwdRecv: {}, fwdResp: {},
    ...over,
  };
}

/** Order-book models that only carry what the orderBook rule reads: the calm condition, on at 10 s and off at 60 s, as fitted. */
const model = (horizonS: number, gate: boolean) => ({ horizonS, calm: { gate, vol60Below: 0.6, maxSpreadTicks: 1, tickUsd: 0.01 } }) as RidgeModel;
const MODELS = [model(10, true), model(60, false)];

const leg = (rule: 'asAnswered' | 'corrected' | 'selective' | 'orderBook') => (recs: DecisionRecord[], horizonS = 10, opts = OPTS, news: NewsRecord[] = []) =>
  pnlReport(recs, opts, news, MODELS)[rule].legs.find(l => l.horizonS === horizonS)!;
const asAnswered = leg('asAnswered');
const corrected = leg('corrected');
const selective = leg('selective');
const orderBook = leg('orderBook');

/** A decision on which the order-book model expected `expectedBp`, with this volatility and spread. At a price of 100, one cent is 1 bp. */
function obDecision(i: number, moveBp: number, expectedBp: number, vol60 = 0.3, spreadUsd = 0.01): DecisionRecord {
  const rec = decision(i, moveBp, 0);
  rec.signals.ob_10s = expectedBp;
  rec.signals.ob_60s = expectedBp;
  rec.vol60 = vol60;
  rec.quote = { bid: 100 - spreadUsd / 2, ask: 100 + spreadUsd / 2 };
  return rec;
}
const near = (a: number, b: number, what?: string) => assert.ok(Math.abs(a - b) < 1e-9, what ?? `${a} is not ${b}`);

// ---- every answer, one size: the mechanics all three rules share -------------------------------

test('a right call earns the move and a wrong one pays it', () => {
  const l = asAnswered([decision(0, 4, 1), decision(1, -6, -1), decision(2, 5, -1)]);
  assert.equal(l.trades, 3);
  assert.equal(l.wins, 2);
  assert.equal(l.losses, 1);
  near(l.totalBps, 4 + 6 - 5);
  near(l.avgBps!, 5 / 3);
  near(l.bestBps!, 6);
  near(l.worstBps!, -5);
});

test('no lean means no trade, and a flat market is a trade that made nothing', () => {
  const l = asAnswered([decision(0, 7, 0), decision(1, 0, 1)]);
  assert.equal(l.trades, 1, 'the answer with no lean sat out');
  assert.equal(l.wins, 0);
  assert.equal(l.losses, 0, 'a price that did not move is not a loss');
  assert.equal(l.totalBps, 0);
});

test('a horizon whose price is not known yet is left out', () => {
  const rec = decision(0, 4, 1);
  rec.fwdResp[10] = null as unknown as number; // how an unfinished horizon comes back from a file
  assert.equal(asAnswered([rec]).trades, 0);
  assert.equal(asAnswered([rec], 60).trades, 1, 'the horizons that did finish still count');
});

test('the fee is charged on both fills of every trade', () => {
  const recs = [decision(0, 4, 1), decision(1, 4, 1)];
  near(asAnswered(recs).totalBps, 8);
  const charged = asAnswered(recs, 10, { ...OPTS, feeBpsPerSide: 1.5 });
  near(charged.totalBps, 2, 'two trades, 1.5 bp on each of their four fills');
  near(charged.grossBps, 8, 'what the moves alone were worth is kept');
  near(charged.costBps, 6);
  assert.equal(charged.wins, 2, 'each one still finished above water');
  const sunk = asAnswered(recs, 10, { ...OPTS, feeBpsPerSide: 2.5 });
  assert.equal(sunk.wins, 0, 'a cost above the move sinks them');
  assert.equal(sunk.right, 2, 'though both calls still had the direction right');
  assert.equal(asAnswered([decision(0, 0, 1)], 10, { ...OPTS, feeBpsPerSide: 1 }).losses, 1, 'once there is a cost, going nowhere loses');
});

test('the spread is charged too: as it stood when the answer arrived, else at the snapshot', () => {
  const rec = decision(0, 4, 1);
  rec.quote = { bid: 99.995, ask: 100.005 }; // 1 bp wide at the snapshot
  near(asAnswered([rec]).totalBps, 3, 'a backtest has only the snapshot quote');
  rec.quoteResp = { bid: 99.99, ask: 100.01 }; // 2 bp wide when the answer arrived
  near(asAnswered([rec]).totalBps, 2);
  near(asAnswered([rec], 10, { ...OPTS, feeBpsPerSide: 0.5 }).totalBps, 1, 'fees and spread add up');
  near(asAnswered([decision(0, 4, 1)]).totalBps, 4, 'a record from before quotes were saved pays no spread');
});

test('"went your way" is the call itself; "wins" are the trades that paid for themselves', () => {
  const l = asAnswered([decision(0, 1, 1), decision(1, 3, 1), decision(2, -2, 1), decision(3, 0, 1)], 10, { ...OPTS, feeBpsPerSide: 1 });
  assert.deepEqual([l.right, l.wrong], [2, 1], 'the flat one is neither');
  assert.deepEqual([l.wins, l.losses], [1, 3], 'only the 3 bp move beat the 2 bp round trip');
});

test('the worst dip is measured from the best point reached, not from the start', () => {
  // Up 10, down 6, down 2, up 1: the running total peaks at 10 and falls to 2.
  const l = asAnswered([decision(0, 10, 1), decision(1, -6, 1), decision(2, -2, 1), decision(3, 1, 1)]);
  near(l.totalBps, 3);
  near(l.maxDrawdownBps, 8);
});

test('the curve is the running total, and stays small enough to send often', () => {
  const many = Array.from({ length: 900 }, (_, i) => decision(i, 1, 1));
  const l = asAnswered(many);
  assert.equal(l.trades, 900);
  assert.ok(l.curve.length <= 240, `thinned to ${l.curve.length}`);
  assert.equal(l.curve[0]!.t, many[0]!.tResp, 'starts at the first trade');
  near(l.curve.at(-1)!.cumBps, 900, 'ends at the total');
});

test('nothing to report is reported as nothing, not as zero profit', () => {
  const set = pnlReport([], OPTS, [], MODELS);
  assert.deepEqual(set.orderBookReach.map(r => [r.calls, r.largestBps, r.meanCostBps]), [[0, null, null], [0, null, null], [0, null, null]]);
  for (const report of [set.asAnswered, set.corrected, set.selective, set.orderBook]) {
    assert.equal(report.n, 0);
    assert.equal(report.since, null);
    assert.deepEqual(
      report.legs.map(l => l.horizonS),
      [2, 10, 60],
    );
    for (const l of report.legs) {
      assert.equal(l.trades, 0);
      assert.equal(l.staked, 0);
      assert.equal(l.avgBps, null);
      assert.equal(l.bestBps, null);
      assert.deepEqual(l.curve, []);
    }
  }
});

// ---- corrected: Jev's answer read against its usual lean -----------------------------------------

test('corrected: "a little less down than usual" is traded as a lean up', () => {
  // Jev answered -0.1, but it has been saying -0.4 all along. The price rose.
  const rec = decision(0, 5, -0.1, { usual: -0.4 });
  near(asAnswered([rec]).totalBps, -5, 'at face value this was a short, and it lost');
  near(corrected([rec]).totalBps, 5, 'read against the usual lean it was a long, and it won');
});

test('corrected: an answer that is exactly the usual one is no lean at all', () => {
  const rec = decision(0, 5, -0.4, { usual: -0.4 });
  assert.equal(asAnswered([rec]).trades, 1);
  assert.equal(corrected([rec]).trades, 0);
});

test('corrected: no call is made while the usual lean is not known yet', () => {
  const rec = decision(0, 5, -0.3);
  // The first minute of a run, as it comes back from a file: what was NaN is saved as null.
  rec.signals.jevc_10s = null as unknown as number;
  rec.lean!.dir_10s = { usual: null as unknown as number, typical: null as unknown as number };
  assert.equal(asAnswered([rec]).trades, 1);
  assert.equal(corrected([rec]).trades, 0);
  assert.equal(selective([rec]).trades, 0);
});

test('corrected: a record from before leans were read this way is not traded, rather than guessed at', () => {
  const rec = decision(0, 5, -0.3);
  delete rec.signals.jevc_10s;
  delete rec.lean;
  assert.equal(corrected([rec]).trades, 0);
  assert.equal(selective([rec]).trades, 0);
});

// ---- selective: the book must agree --------------------------------------------------------------

test('selective: sits out unless the best level of the order book points the same way', () => {
  assert.equal(selective([decision(0, 5, 0.5, { book: -0.6 })]).trades, 0, 'the book leans the other way');
  assert.equal(selective([decision(0, 5, 0.5, { book: 0 })]).trades, 0, 'a book with no opinion does not count as agreeing');
  assert.equal(selective([decision(0, 5, 0.5, { book: 0.2 })]).trades, 1);
});

test('selective: it is the corrected lean the book has to agree with, not the answer at face value', () => {
  // Answered -0.1 against a usual -0.4: a lean up. A bid-heavy book agrees with that.
  const rec = decision(0, 5, -0.1, { usual: -0.4, book: 0.7 });
  const l = selective([rec]);
  assert.equal(l.trades, 1);
  assert.ok(l.totalBps > 0, 'and it went long');
});

test('selective: the other simple rules no longer open the gate by themselves', () => {
  const rec = decision(0, 5, 0.5, { book: -0.6 });
  Object.assign(rec.signals, { obi5: 1, flow5: 1, mom5: 1 });
  assert.equal(selective([rec]).trades, 0);
});

// ---- selective: staking by the strength of the lean ------------------------------------------------

test('selective: an ordinary lean is one normal stake, a weaker one less, a stronger one more', () => {
  near(selective([decision(0, 8, 0.5, { typical: 0.5 })]).totalBps, 8, 'as strong as Jev typically leans: one stake');
  near(selective([decision(0, 8, 0.1, { typical: 0.5 })]).totalBps, 8 * 0.2);
  near(selective([decision(0, 8, 0.75, { typical: 0.5 })]).totalBps, 8 * 1.5);
});

test('selective: never more than twice the normal stake, however strong the lean', () => {
  near(selective([decision(0, 8, 0.9, { typical: 0.1 })]).totalBps, 8 * 2);
  near(selective([decision(0, 8, 0.9, { typical: 0 })]).totalBps, 8 * 2, 'even when every earlier answer was identical');
});

test("selective: TypeSafe's confidence plays no part in the stake", () => {
  const sure = decision(0, 8, 0.5);
  const unsure = decision(0, 8, 0.5);
  unsure.confidence = { dir_2s: 0.1, dir_10s: 0.1, dir_60s: 0.1 };
  near(selective([sure]).totalBps, selective([unsure]).totalBps);
});

test('selective: the average is per stake put down, so betting small is not marked down', () => {
  // Two winning calls of +8 bp: one at a fifth of a stake, one at a stake and a half.
  const l = selective([decision(0, 8, 0.1, { typical: 0.5 }), decision(1, 8, 0.75, { typical: 0.5 })]);
  near(l.staked, 0.2 + 1.5);
  near(l.totalBps, 8 * 1.7);
  near(l.avgBps!, 8, 'every unit staked made 8 bp');
});

test('selective: best and worst describe the call, not the stake it was given', () => {
  // A weak, small-stake win next to a strong, double-stake loss: the win must not look "best" just for being smaller.
  const l = selective([decision(0, 8, 0.1, { typical: 0.5 }), decision(1, -8, 0.9, { typical: 0.1 })]);
  near(l.bestBps!, 8, 'the +8 bp call was the best, regardless of its stake');
  near(l.worstBps!, -8);
});

// ---- selective: a recent headline --------------------------------------------------------------------

test('selective: sits out when a recent headline leans the other way', () => {
  const rec = decision(0, 5, 0.5);
  const news = [newsRecord({ tResp: rec.tState - 60_000, signal: -0.8 })];
  assert.equal(selective([rec], 10, OPTS, news).trades, 0);
});

test('selective: a headline older than the lookback window no longer counts', () => {
  const rec = decision(0, 5, 0.5);
  const news = [newsRecord({ tResp: rec.tState - 20 * 60_000, signal: -0.8 })]; // 20 minutes old
  assert.equal(selective([rec], 10, OPTS, news).trades, 1, 'too old to still apply, so the trade goes through');
});

test('selective: stakes a little more when a recent headline agrees', () => {
  const rec = decision(0, 8, 0.5, { typical: 0.5 });
  near(selective([rec]).totalBps, 8);
  const withNews = selective([rec], 10, OPTS, [newsRecord({ tResp: rec.tState - 60_000, signal: 0.7 })]);
  near(withNews.totalBps, 8 * 1.25, 'a fixed, modest boost, not an unbounded one');
});

test('selective: never uses a headline that arrived after the decision (no lookahead)', () => {
  const rec = decision(0, 5, 0.5);
  const future = newsRecord({ tResp: rec.tState + 1, signal: -0.9 }); // one ms after the snapshot: not yet known
  assert.equal(selective([rec], 10, OPTS, [future]).trades, 1, 'a headline from the future must not veto a real trade');
});

test('selective: a headline about a different instrument has no say over this one', () => {
  const rec = decision(0, 5, 0.5);
  const news = [newsRecord({ tResp: rec.tState - 60_000, signal: -0.9, symbol: 'AAPL' })];
  assert.equal(selective([rec], 10, OPTS, news).trades, 1, 'a headline about AAPL says nothing about BTC-USD');
});

// ---- orderBook: the order-book model, traded only when it can pay for itself ---------------------

test('orderBook: trades only a call whose expected move beats the whole round trip', () => {
  const opts = { ...OPTS, feeBpsPerSide: 1 }; // 2 bp in fees, plus a one-cent spread: 3 bp a round trip
  const l = orderBook([obDecision(0, 5, 3.5), obDecision(1, 5, 2.9), obDecision(2, -5, -4)], 10, opts);
  assert.equal(l.trades, 2, 'the 2.9 bp expectation could not pay for a 3 bp round trip');
  near(l.grossBps, 10);
  near(l.costBps, 2 * 3, 'fees on both fills, and the spread');
});

test('orderBook: at 10 s it waits for a calm minute and a one-tick spread', () => {
  const l = orderBook([obDecision(0, 5, 3), obDecision(1, 5, 3, 0.9), obDecision(2, 5, 3, 0.3, 0.02), obDecision(3, 5, 3, NaN)]);
  assert.equal(l.trades, 1, 'too volatile, two ticks wide, and unknown volatility all sit out');
});

test('orderBook: at 60 s, where calm made no difference, it does not wait for it', () => {
  assert.equal(orderBook([obDecision(0, 5, 8, 0.9, 0.05)], 60).trades, 1, 'volatile and five ticks wide, but 8 bp expected beats the 5 bp spread');
});

test('orderBook: says how close it came when it took nothing', () => {
  const recs = [obDecision(0, 5, 0.4), obDecision(1, 5, -0.7), obDecision(2, 5, 3, 0.9), decision(3, 5, 1)];
  const reach = pnlReport(recs, { ...OPTS, feeBpsPerSide: 5 }, [], MODELS).orderBookReach.find(r => r.horizonS === 10)!;
  assert.equal(reach.calls, 3, 'the record without an order-book call is not counted');
  assert.equal(reach.calm, 2);
  near(reach.largestBps!, 0.7, 'the biggest expectation among calm calls, whichever way');
  near(reach.meanCostBps!, 11, 'two 5 bp fees and a 1 bp spread');
  assert.equal(orderBook(recs, 10, { ...OPTS, feeBpsPerSide: 5 }).trades, 0);
});

test('orderBook: a record from before the model existed is never traded', () => {
  assert.equal(orderBook([decision(0, 5, 1)]).trades, 0);
});
