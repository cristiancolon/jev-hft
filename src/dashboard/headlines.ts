// Jev's verdicts on headlines about the traded instrument, from the moment each is answered.
//
// The news program saves a headline's record only once its last price check is done, 30 minutes
// after Jev answers. Waiting for that left the trading rules blind to the newest news, which is
// the news that matters most: the selective rule's "does a recent headline disagree" check could
// only ever see headlines that were already 30 minutes old, and nothing could trade a headline
// while it was fresh. So each verdict is taken from the answer's telemetry as it arrives, its
// later prices are filled in from the news program's own once-a-second price as each check comes
// due, and the saved record, with its exact prices, replaces it once there is one
// (docs/decisions.md D60).

import type { NewsRecord } from '../news/engine.ts';
import type { NewsAnswered } from '../telemetry/events.ts';
import type { Tick } from './collector.ts';

/** What the trading rules need to know about a headline, whether it came from telemetry or a saved record. */
export type NewsCall = Pick<NewsRecord, 'symbol' | 'assetClass' | 'tResp' | 'signal' | 'magnitude' | 'midResp' | 'spreadBps' | 'fwdResp'>;

export type Headline = NewsCall & {
  /** Which item it was about, so the saved record can find it. */
  id: string;
  /** From a saved record: its prices are exact and final. */
  saved: boolean;
};

/**
 * A price from the once-a-second ticks further than this from when a check came due is not a
 * price at that time: the program was paused or its connection was down.
 */
const TICK_TOLERANCE_MS = 2000;

const key = (id: string, symbol: string, tResp: number) => `${id}|${symbol}|${tResp}`;

/** The newest headlines about one instrument, oldest first. */
export class HeadlineBook {
  private readonly byKey = new Map<string, Headline>();
  private sorted: Headline[] = [];
  private readonly product: string;
  private readonly limit: number;

  constructor(product: string, limit: number) {
    this.product = product;
    this.limit = limit;
  }

  /** A verdict as it arrives. Returns whether anything changed. */
  answered(e: Pick<NewsAnswered, 'id' | 'tResp' | 'verdicts'>): boolean {
    let changed = false;
    for (const v of e.verdicts) {
      if (v.symbol !== this.product || v.mid === null || !Number.isFinite(v.mid)) continue;
      const k = key(e.id, v.symbol, e.tResp);
      if (this.byKey.has(k)) continue;
      this.byKey.set(k, {
        id: e.id,
        symbol: v.symbol,
        // The traded instrument is a Coinbase product, which the news program always treats as crypto.
        assetClass: 'crypto',
        tResp: e.tResp,
        signal: v.signal,
        magnitude: v.magnitude,
        midResp: v.mid,
        spreadBps: v.spreadBps ?? NaN,
        fwdResp: {},
        saved: false,
      });
      changed = true;
    }
    if (changed) this.reorder();
    return changed;
  }

  /** A saved record, which replaces the verdict it came from. Returns whether anything changed. */
  saved(rec: NewsRecord): boolean {
    if (rec.symbol !== this.product || !Number.isFinite(rec.signal) || !Number.isFinite(rec.magnitude) || !Number.isFinite(rec.midResp)) return false;
    const k = key(rec.item.id, rec.symbol, rec.tResp);
    if (this.byKey.get(k)?.saved) return false;
    const { symbol, assetClass, tResp, signal, magnitude, midResp, spreadBps, fwdResp } = rec;
    this.byKey.set(k, { id: rec.item.id, symbol, assetClass, tResp, signal, magnitude, midResp, spreadBps, fwdResp, saved: true });
    this.reorder();
    return true;
  }

  /**
   * Fill in each check that has come due on a headline not yet saved, from the news program's
   * ticks: the tick nearest the moment, if one is close enough. A check whose moment the ticks
   * have not reached yet is left for later. Returns whether anything changed.
   */
  settle(ticks: readonly Tick[], horizonsS: readonly number[]): boolean {
    const last = ticks.at(-1);
    if (!last) return false;
    let changed = false;
    for (const h of this.sorted) {
      if (h.saved) continue;
      for (const horizonS of horizonsS) {
        if (Number.isFinite(h.fwdResp[horizonS])) continue;
        const due = h.tResp + horizonS * 1000;
        if (last.t < due) continue;
        const tick = nearest(ticks, due);
        if (tick && Math.abs(tick.t - due) <= TICK_TOLERANCE_MS) {
          h.fwdResp[horizonS] = tick.mid;
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Oldest first, at most `limit` of them. */
  list(): readonly Headline[] {
    return this.sorted;
  }

  private reorder() {
    // Two calls can finish a moment out of order, and the rules look for the latest headline before a given time.
    this.sorted = [...this.byKey.values()].sort((a, b) => a.tResp - b.tResp);
    for (const old of this.sorted.splice(0, Math.max(0, this.sorted.length - this.limit))) this.byKey.delete(key(old.id, old.symbol, old.tResp));
  }
}

/** The tick closest in time to `t`, in ticks sorted by time. */
function nearest(ticks: readonly Tick[], t: number): Tick | undefined {
  let lo = 0;
  let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  const after = ticks[lo];
  const before = ticks[lo - 1];
  if (!before) return after;
  if (!after) return before;
  return t - before.t <= after.t - t ? before : after;
}
