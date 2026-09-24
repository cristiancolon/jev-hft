// Order-book measurements beyond the six lines Jev reads, for research/extract.ts and the
// order-book model (src/model/ridge.ts).
//
// Two kinds. `bookShape` is a still picture of the book: imbalance over more levels, and how the
// best two queues compare. `Microstructure` keeps running counts on every market event (order-flow
// imbalance, trade flow, how often the mid moves) and reads them over trailing windows.
//
// The research (docs/accuracy.md) tried both. Only the still picture earned its place in the
// model: the flow measurements explain the move that is happening, not the next one. So the live
// engine calls bookShape once per decision and does no extra work per event; Microstructure is
// kept for the research, which replays recordings through it.
//
// Everything is driven by event timestamps, like MarketState, so a replay gives exactly the
// numbers a live run would have seen.

import type { MarketEvent } from '../feed/types.ts';
import type { MarketState } from './state.ts';

/** Book levels tracked for order-flow imbalance. */
const OFI_LEVELS = 5;
/** One-second samples kept: enough for the longest window read. */
const SAMPLE_SECONDS = 301;

/** Trailing windows (seconds) the counters are read over. */
export const WINDOWS = [1, 5, 10, 30, 60] as const;

type Sample = {
  t: number;
  mid: number;
  ofi1: number;
  ofi5: number;
  tradeFlow: number;
  trades: number;
  buys: number;
  midMoves: number;
  imb1: number;
  imb5: number;
};

export type Micro = Record<string, number>;

export class Microstructure {
  /** Cumulative order-flow imbalance (Cont, Kukanov and Stoikov 2014) at the best level, and summed over the best five. */
  private ofi1 = 0;
  private ofi5 = 0;
  /** Cumulative taker buy minus sell volume, trade count, and buy count. */
  private tradeFlow = 0;
  private trades = 0;
  private buys = 0;
  /** How many times the mid has changed, and when it last did. */
  private midMoves = 0;
  private lastMidMove = NaN;
  private lastMid = NaN;
  /** The best levels as of the previous book event: [price, size] per level. */
  private prevBid: [number, number][] = [];
  private prevAsk: [number, number][] = [];
  private samples: Sample[] = [];
  private lastSec = 0;
  /** Running average best-level size, so flow reads relative to how deep the book usually is. */
  private l1DepthAvg = NaN;
  private readonly state: MarketState;

  constructor(state: MarketState) {
    this.state = state;
  }

  /** Call after `state.apply(e)` for every event. */
  apply(e: MarketEvent) {
    const s = this.state;
    if (e.type === 'reset' || !s.ready) {
      // Flow across a gap in the data would be made up; start the comparisons over.
      this.prevBid = [];
      this.prevAsk = [];
      this.samples = [];
      this.lastMid = NaN;
      return;
    }
    if (e.type === 'trade') {
      this.tradeFlow += e.aggressor === 'buy' ? e.size : -e.size;
      this.trades++;
      if (e.aggressor === 'buy') this.buys++;
    } else {
      const bid = this.levels('bid');
      const ask = this.levels('ask');
      if (this.prevBid.length > 0 && this.prevAsk.length > 0) {
        for (let i = 0; i < OFI_LEVELS; i++) {
          const x = ofiAt(this.prevBid[i], bid[i], this.prevAsk[i], ask[i]);
          if (i === 0) this.ofi1 += x;
          this.ofi5 += x;
        }
      }
      this.prevBid = bid;
      this.prevAsk = ask;
      const mid = s.book.mid;
      if (mid !== this.lastMid) {
        if (!Number.isNaN(this.lastMid)) {
          this.midMoves++;
          this.lastMidMove = e.recvTs;
        }
        this.lastMid = mid;
      }
    }
    this.sample(e.recvTs);
  }

  /** Measurements as of time `t`. A window reaching back past the data (warm-up, a gap) is NaN. */
  read(t: number): Micro {
    const s = this.state;
    const b = s.book;
    const mid = b.mid;
    const now = this.snapshot(t);
    const depth = this.l1DepthAvg;
    const out: Micro = {
      ...bookShape(s),
      sinceMidMoveS: (t - this.lastMidMove) / 1000,
      l1Depth: depth,
    };
    for (const w of WINDOWS) {
      const then = this.at(t - w * 1000);
      const d = (k: keyof Sample) => (then ? now[k] - then[k] : NaN);
      const n = d('trades');
      out[`ofi1_${w}`] = d('ofi1') / depth;
      out[`ofi5_${w}`] = d('ofi5') / depth;
      out[`tflow_${w}`] = d('tradeFlow') / depth;
      out[`tcount_${w}`] = n;
      out[`tsign_${w}`] = n > 0 ? (2 * d('buys') - n) / n : 0;
      out[`moves_${w}`] = d('midMoves');
      out[`ret_${w}`] = then ? ((mid - then.mid) / then.mid) * 1e4 : NaN;
      out[`dimb1_${w}`] = d('imb1');
      out[`dimb5_${w}`] = d('imb5');
    }
    for (const w of [120, 300]) {
      const then = this.at(t - w * 1000);
      out[`ret_${w}`] = then ? ((mid - then.mid) / then.mid) * 1e4 : NaN;
    }
    // MarketState already has the 60-second figure (vol60).
    out.vol10 = this.vol(10);
    out.vol300 = this.vol(300);
    // Time of day (UTC) as a point on a circle, so 23:59 and 00:00 sit next to each other.
    const day = ((t / 1000) % 86_400) / 86_400;
    out.todSin = Math.sin(2 * Math.PI * day);
    out.todCos = Math.cos(2 * Math.PI * day);
    return out;
  }

  private snapshot(t: number): Sample {
    const s = this.state;
    return { t, mid: s.book.mid, ofi1: this.ofi1, ofi5: this.ofi5, tradeFlow: this.tradeFlow, trades: this.trades, buys: this.buys, midMoves: this.midMoves, imb1: imb(s, 1), imb5: imb(s, 5) };
  }

  private levels(side: 'bid' | 'ask'): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < OFI_LEVELS; i++) {
      const l = this.state.book.level(side, i);
      if (!l) break;
      out.push(l);
    }
    return out;
  }

  private sample(t: number) {
    const sec = Math.floor(t / 1000);
    if (sec <= this.lastSec) return;
    this.lastSec = sec;
    const b = this.state.book;
    const l1 = (b.level('bid', 0)?.[1] ?? 0) + (b.level('ask', 0)?.[1] ?? 0);
    // About a five-minute average: steady enough to divide by, quick enough to follow the day.
    this.l1DepthAvg = Number.isNaN(this.l1DepthAvg) ? l1 : this.l1DepthAvg + (l1 - this.l1DepthAvg) / 300;
    this.samples.push(this.snapshot(t));
    if (this.samples.length > SAMPLE_SECONDS + 64) this.samples.splice(0, 64);
  }

  /** The newest sample at or before `t`, if the samples reach back that far. */
  private at(t: number): Sample | undefined {
    const xs = this.samples;
    if (xs.length === 0 || xs[0]!.t > t) return undefined;
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (xs[m]!.t <= t) lo = m + 1;
      else hi = m;
    }
    const s = xs[lo - 1]!;
    return t - s.t <= 2000 ? s : undefined; // more than two seconds stale: the feed was quiet or broken
  }

  /** Standard deviation of one-second mid returns over the last `seconds`, in bps. */
  private vol(seconds: number) {
    const xs = this.samples;
    const n = Math.min(seconds, xs.length - 1);
    if (n < Math.min(seconds, 10)) return NaN;
    let sum = 0;
    let sq = 0;
    for (let i = xs.length - n; i < xs.length; i++) {
      const r = ((xs[i]!.mid - xs[i - 1]!.mid) / xs[i - 1]!.mid) * 1e4;
      sum += r;
      sq += r * r;
    }
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sq / n - mean * mean));
  }
}

/**
 * The book as it stands: size imbalance over the best 2, 3 and 10 levels, imbalance of the size
 * resting within 2, 5 and 25 bps of the mid, and the log of best bid size over best ask size.
 */
export function bookShape(s: MarketState): Micro {
  const b = s.book;
  return {
    imb2: imb(s, 2),
    imb3: imb(s, 3),
    imb10: imb(s, 10),
    dimb2: depthImb(s, 2),
    dimb5: depthImb(s, 5),
    dimb25: depthImb(s, 25),
    l1LogRatio: Math.log((b.level('bid', 0)?.[1] ?? NaN) / (b.level('ask', 0)?.[1] ?? NaN)),
  };
}

/** One level's contribution to order-flow imbalance: size added to the bid or taken off the ask pushes up. */
function ofiAt(pb: [number, number] | undefined, b: [number, number] | undefined, pa: [number, number] | undefined, a: [number, number] | undefined) {
  if (!pb || !b || !pa || !a) return 0;
  const bidPart = (b[0] >= pb[0] ? b[1] : 0) - (b[0] <= pb[0] ? pb[1] : 0);
  const askPart = (a[0] <= pa[0] ? a[1] : 0) - (a[0] >= pa[0] ? pa[1] : 0);
  return bidPart - askPart;
}

function imb(s: MarketState, n: number) {
  const bs = s.book.topSize('bid', n);
  const as = s.book.topSize('ask', n);
  return (bs - as) / (bs + as);
}

function depthImb(s: MarketState, bps: number) {
  const bs = s.book.depthWithin('bid', bps);
  const as = s.book.depthWithin('ask', bps);
  return (bs - as) / (bs + as);
}
