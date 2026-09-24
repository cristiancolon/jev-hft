import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LevelUpdate, MarketEvent } from '../src/feed/types.ts';
import { bookShape, Microstructure } from '../src/market/microstructure.ts';
import { MarketState } from '../src/market/state.ts';

const T0 = 1_800_000_000_000; // a whole second, so each event below falls in a new one
const near = (a: number, b: number, what?: string) => assert.ok(Math.abs(a - b) < 1e-9, what ?? `${a} is not ${b}`);

const book = (t: number, updates: LevelUpdate[], snapshot = false): MarketEvent => ({ type: 'book', snapshot, updates, exchTs: t - 50, recvTs: t });
const trade = (t: number, size: number, aggressor: 'buy' | 'sell'): MarketEvent => ({ type: 'trade', price: 100, size, aggressor, exchTs: t - 80, recvTs: t });
const bid = (price: number, size: number): LevelUpdate => ({ side: 'bid', price, size });
const ask = (price: number, size: number): LevelUpdate => ({ side: 'ask', price, size });

function feed(events: MarketEvent[]) {
  const state = new MarketState();
  const micro = new Microstructure(state);
  for (const e of events) {
    state.apply(e);
    micro.apply(e);
  }
  return { state, micro };
}

test('size added to the best bid, or taken off the best ask, counts as buying pressure', () => {
  const { micro } = feed([
    book(T0, [bid(99.5, 1), ask(100.5, 1)], true),
    book(T0 + 1000, [bid(99.5, 3)]), // 2 more wanting to buy at the best bid
    book(T0 + 2000, [ask(100.5, 0.5)]), // half the best ask taken away
    trade(T0 + 3000, 0.1, 'buy'),
  ]);
  const m = micro.read(T0 + 5500); // five seconds back is just after the first snapshot
  // Order flow is divided by the usual size at the best level, so undo that to check the count.
  near(m.ofi1_5! * m.l1Depth!, 2.5, 'bid added (+2) and ask cancelled (+0.5)');
  near(m.ofi5_5! * m.l1Depth!, 2.5, 'with one level a side, five levels see the same');
  near(m.ofi1_1! * m.l1Depth!, 0, 'nothing changed on the book in the last second');
});

test('a better bid pushes up and a better ask pushes down', () => {
  const up = feed([book(T0, [bid(99.5, 1), ask(100.5, 1)], true), book(T0 + 1000, [bid(99.75, 2)]), trade(T0 + 2000, 0.1, 'buy')]).micro.read(T0 + 5500);
  assert.ok(up.ofi1_5! > 0);
  const down = feed([book(T0, [bid(99.5, 1), ask(100.5, 1)], true), book(T0 + 1000, [ask(100.25, 2)]), trade(T0 + 2000, 0.1, 'buy')]).micro.read(T0 + 5500);
  assert.ok(down.ofi1_5! < 0);
});

test('trades and mid moves are counted over each window', () => {
  const { micro } = feed([
    book(T0, [bid(99.5, 1), ask(100.5, 1)], true),
    trade(T0 + 1000, 0.5, 'buy'),
    trade(T0 + 2000, 0.2, 'sell'),
    book(T0 + 3000, [bid(99.5, 0), bid(99.75, 1)]), // the mid moves up once
  ]);
  const m = micro.read(T0 + 5500);
  assert.equal(m.tcount_5, 2);
  near(m.tflow_5! * m.l1Depth!, 0.3, 'bought 0.5, sold 0.2');
  assert.equal(m.tsign_5, 0, 'one buy and one sell');
  assert.equal(m.moves_5, 1);
  near(m.sinceMidMoveS!, 2.5);
  assert.ok(m.ret_5! > 0, 'the mid is higher than five seconds ago');
});

test('a window that reaches back before the data is unknown, not zero', () => {
  const { micro } = feed([book(T0, [bid(99.5, 1), ask(100.5, 1)], true), trade(T0 + 1000, 0.5, 'buy')]);
  const m = micro.read(T0 + 1500);
  assert.ok(Number.isFinite(m.tcount_1));
  for (const k of ['tcount_5', 'ofi1_10', 'ret_60', 'ret_300']) assert.ok(Number.isNaN(m[k]), `${k} is NaN`);
});

test('a break in the feed starts the windows over, so no flow is made up across it', () => {
  const { micro } = feed([
    book(T0, [bid(99.5, 1), ask(100.5, 1)], true),
    trade(T0 + 1000, 0.5, 'buy'),
    trade(T0 + 2000, 0.5, 'buy'),
    { type: 'reset', recvTs: T0 + 3000 },
    book(T0 + 4000, [bid(99.5, 1), ask(100.5, 1)], true),
  ]);
  assert.ok(Number.isNaN(micro.read(T0 + 4500).tcount_5), 'the trades before the break are not counted');
});

test('the still picture: imbalance over more levels, and the best queues compared', () => {
  const { state } = feed([book(T0, [bid(99.5, 2), bid(99, 1), bid(98.5, 1), ask(100.5, 1), ask(101, 1), ask(101.5, 1)], true)]);
  const b = bookShape(state);
  near(b.imb2!, (3 - 2) / 5);
  near(b.imb3!, (4 - 3) / 7);
  near(b.l1LogRatio!, Math.log(2));
});
