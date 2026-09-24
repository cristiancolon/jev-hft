// What a round trip costs, in one place, for the reports and the dashboard's profit and loss.
//
// A taker pays twice for a round trip: the exchange's fee on each fill, and the spread, since it
// buys at the ask and sells at the bid (or the other way round). The spread is charged as it
// stood when the trade would have been placed, which is the best estimate of what closing will
// cost too. On Coinbase BTC-USD that is usually a single cent, about 0.001 bp, so for this
// product the fee is almost the whole cost (docs/accuracy.md).

import type { DecisionRecord } from '../engine.ts';

/** The spread a trade placed with this decision would have crossed, in bps. 0 for records from before quotes were saved. */
export function spreadBps(rec: Pick<DecisionRecord, 'quote' | 'quoteResp'>): number {
  const q = rec.quoteResp ?? rec.quote;
  if (!q || !(q.ask > q.bid)) return 0;
  return ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 1e4;
}

/** The whole cost of opening and closing one trade, in bps: two fees and the spread. */
export function roundTripBps(rec: Pick<DecisionRecord, 'quote' | 'quoteResp'>, feeBpsPerSide: number): number {
  return roundTripAt(spreadBps(rec), feeBpsPerSide);
}

/** The same, for a trade whose spread is already known in bps (a news record carries its own). An unknown spread counts as none. */
export function roundTripAt(spread: number, feeBpsPerSide: number): number {
  return 2 * feeBpsPerSide + (Number.isFinite(spread) && spread > 0 ? spread : 0);
}
