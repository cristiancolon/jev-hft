import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DepthSync, tradeEvent, type DepthDiff } from '../src/feed/binanceus.ts';
import type { MarketEvent } from '../src/feed/types.ts';
import { MarketState } from '../src/market/state.ts';

const T0 = 1_800_000_000_000;

/** A diff covering updates U..u. Its exchange time is T0 + U, so each diff's time is easy to check. */
const diff = (U: number, u: number, b: [string, string][] = [], a: [string, string][] = []): DepthDiff => ({ e: 'depthUpdate', E: T0 + U, U, u, b, a });
const snapshot = (lastUpdateId: number) => ({ lastUpdateId, bids: [['100.00', '1'], ['99.99', '2']] as [string, string][], asks: [['100.02', '1'], ['100.03', '3']] as [string, string][] });

function setup() {
  const out: MarketEvent[] = [];
  return { sync: new DepthSync(e => out.push(e)), out };
}

test('the book is rebuilt from the snapshot and the diffs held while it was fetched', () => {
  const { sync, out } = setup();
  sync.diff(diff(5, 7, [['99.98', '1']]), T0 + 10); // already in the snapshot
  sync.diff(diff(8, 9, [['100.00', '0']]), T0 + 20); // reaches across it
  sync.diff(diff(10, 12, [], [['100.02', '4']]), T0 + 30);
  assert.equal(out.length, 0, 'nothing is known until the snapshot arrives');
  assert.equal(sync.snapshot(snapshot(8), T0 + 500), 'ok');
  assert.equal(out.length, 3, 'the snapshot, then the two diffs it did not already have');
  assert.equal(out[0]!.type === 'book' && out[0]!.snapshot, true);
  for (const e of out) assert.equal(e.recvTs, T0 + 500, 'the book became known when the snapshot arrived');
  assert.deepEqual(out.map(e => (e.type === 'book' ? e.exchTs : NaN)), [T0 + 500, T0 + 8, T0 + 10], "each diff keeps the exchange's own time");
  assert.ok(sync.synced);
  assert.equal(sync.diff(diff(13, 13), T0 + 600), true, 'the stream carries on from there');
});

test('a snapshot older than everything held is fetched again', () => {
  const { sync, out } = setup();
  sync.diff(diff(20, 22), T0);
  assert.equal(sync.snapshot(snapshot(10), T0 + 100), 'early', 'updates 11 to 19 were never seen');
  assert.equal(out.length, 0);
  assert.equal(sync.synced, false);
  assert.equal(sync.snapshot(snapshot(21), T0 + 300), 'ok', 'a newer one joins up');
});

test('held diffs that do not join up mean starting over', () => {
  const { sync } = setup();
  sync.diff(diff(5, 9), T0);
  sync.diff(diff(12, 13), T0 + 10); // 10 and 11 went missing
  assert.equal(sync.snapshot(snapshot(8), T0 + 100), 'gap');
});

test('once live, every diff must start exactly where the last one ended', () => {
  const { sync } = setup();
  sync.diff(diff(1, 2), T0);
  assert.equal(sync.snapshot(snapshot(2), T0 + 100), 'ok');
  assert.equal(sync.diff(diff(3, 5), T0 + 200), true);
  assert.equal(sync.diff(diff(7, 8), T0 + 300), false, 'update 6 was missed');
});

test('with nothing new held, the first live diff may reach across the snapshot, and older ones are dropped', () => {
  const { sync, out } = setup();
  sync.diff(diff(1, 3), T0);
  assert.equal(sync.snapshot(snapshot(10), T0 + 100), 'ok');
  assert.equal(sync.diff(diff(5, 10, [['99.97', '1']]), T0 + 200), true, 'already in the snapshot');
  assert.equal(out.length, 1, 'so nothing was applied');
  assert.equal(sync.diff(diff(9, 12, [['99.97', '1']]), T0 + 300), true);
  assert.equal(sync.diff(diff(13, 13), T0 + 400), true);
  assert.equal(sync.diff(diff(15, 15), T0 + 500), false);
});

test('a diff that changes nothing is followed but not recorded', () => {
  const { sync, out } = setup();
  sync.diff(diff(1, 1), T0);
  sync.snapshot(snapshot(1), T0 + 100);
  assert.equal(sync.diff(diff(2, 3), T0 + 200), true);
  assert.equal(out.length, 1, 'only the snapshot');
});

test("a trade's side is the one that made it happen: when the buyer was resting, the seller did", () => {
  const sold = tradeEvent({ e: 'trade', p: '84200.10', q: '0.002', T: T0, m: true }, T0 + 65);
  assert.deepEqual(sold, { type: 'trade', price: 84200.1, size: 0.002, aggressor: 'sell', exchTs: T0, recvTs: T0 + 65 });
  const bought = tradeEvent({ e: 'trade', p: '1', q: '1', T: T0, m: false }, T0);
  assert.equal(bought.type === 'trade' ? bought.aggressor : null, 'buy');
});

test('the events rebuild the same book in the market state, with removed levels gone', () => {
  const { sync, out } = setup();
  sync.diff(diff(1, 1), T0);
  sync.snapshot(snapshot(1), T0 + 100);
  sync.diff(diff(2, 2, [['100.00', '0.00000000']], [['100.01', '0.5']]), T0 + 200); // best bid pulled, a better ask added
  const state = new MarketState();
  for (const e of out) state.apply(e);
  assert.ok(state.ready);
  assert.equal(state.book.bestBid, 99.99);
  assert.equal(state.book.bestAsk, 100.01);
  assert.equal(state.book.level('ask', 0)![1], 0.5);
});
