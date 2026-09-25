// Reading Jev's lean against its own recent answers.
//
// Jev's answers have a standing lean. Over nine hours in which the price was as likely to rise
// as to fall, it leaned "down" in more than 80% of its answers, because things that are one-sided
// all day (more sell trades than buy trades, a deeper ask side, a slow drift) read as bearish
// every single second. Taken at face value, "slightly down" is then Jev's neutral, and an answer
// a little above it is really a lean up.
//
// So each lean is read against what Jev has usually been saying lately: the middle of its own
// answers over the last few minutes. Two things make this safe to rely on. It looks only at
// Jev's earlier answers, never at prices, so there is nothing for it to be fitted to. And it uses
// only answers that had already arrived, so a live run could have done exactly the same
// (docs/model.md, docs/decisions.md D50).

import type { DecisionRecord } from '../engine.ts';
import { DIRECTIONS, directionSignal, type DirectionId, type Probabilities } from './jev.ts';

/** How far back "lately" reaches. Anything from 2 to 60 minutes scored alike, so this is not a tuned number. */
export const LEAN_WINDOW_MS = 15 * 60_000;
/** Fewer earlier answers than this and the usual lean is not known yet (about a minute at one a second). */
export const LEAN_MIN_ANSWERS = 60;

/** What Jev's lean has usually been lately, and how far from that its leans typically stray. */
export type LeanReading = { usual: number; typical: number };

/** The recent leans of one question, kept in arrival order and in size order. */
export class LeanTracker {
  private readonly times: number[] = [];
  private readonly values: number[] = [];
  private readonly sorted: number[] = [];
  private readonly windowMs: number;
  private readonly minAnswers: number;

  constructor(windowMs = LEAN_WINDOW_MS, minAnswers = LEAN_MIN_ANSWERS) {
    this.windowMs = windowMs;
    this.minAnswers = minAnswers;
  }

  /** The reading as of time `t`, from the answers pushed so far. Unknown (NaN) until there are enough. */
  read(t: number): LeanReading {
    this.expire(t);
    const n = this.sorted.length;
    if (n < this.minAnswers) return { usual: NaN, typical: NaN };
    const usual = n % 2 === 1 ? this.sorted[(n - 1) / 2]! : (this.sorted[n / 2 - 1]! + this.sorted[n / 2]!) / 2;
    let strayed = 0;
    for (const x of this.sorted) strayed += Math.abs(x - usual);
    return { usual, typical: strayed / n };
  }

  push(t: number, lean: number) {
    if (!Number.isFinite(lean)) return;
    this.times.push(t);
    this.values.push(lean);
    this.sorted.splice(this.place(lean), 0, lean);
  }

  private expire(t: number) {
    while (this.times.length > 0 && this.times[0]! < t - this.windowMs) {
      this.times.shift();
      this.sorted.splice(this.place(this.values.shift()!), 1);
    }
  }

  /** Where `x` is (or belongs) in the sorted list. */
  private place(x: number) {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sorted[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/** Jev's lean with its usual lean taken out: above zero is a real lean up, below is a real lean down. */
export const correctedLean = (lean: number, reading: LeanReading | undefined) => lean - (reading?.usual ?? NaN);

/**
 * How strong a corrected lean is next to Jev's typical one: 1 is an ordinary lean, 2 is twice as
 * strong. Stronger leans were right more often, steadily, from about 54% for the weakest fifth to
 * about 75% for the strongest at two seconds.
 */
export function conviction(corrected: number, reading: LeanReading | undefined): number {
  if (!reading || !Number.isFinite(corrected) || !Number.isFinite(reading.typical)) return NaN;
  if (corrected === 0) return 0;
  return reading.typical > 0 ? Math.abs(corrected) / reading.typical : Infinity;
}

export const correctedKey = (id: DirectionId) => `jevc_${id.slice(4)}`;

/** One tracker per direction question. */
export class LeanBook {
  private readonly trackers: Record<DirectionId, LeanTracker>;

  constructor(windowMs = LEAN_WINDOW_MS, minAnswers = LEAN_MIN_ANSWERS) {
    this.trackers = Object.fromEntries(Object.keys(DIRECTIONS).map(id => [id, new LeanTracker(windowMs, minAnswers)])) as Record<DirectionId, LeanTracker>;
  }

  /**
   * Read an answer that arrived at `t` against the answers before it, then add it to them. The
   * order matters: an answer is never part of its own "usual".
   */
  take(t: number, probabilities: Record<string, Probabilities>): { lean: Record<DirectionId, LeanReading>; signals: Record<string, number> } {
    const lean = {} as Record<DirectionId, LeanReading>;
    const signals: Record<string, number> = {};
    for (const id of Object.keys(DIRECTIONS) as DirectionId[]) {
      const answered = directionSignal(probabilities[id] ?? {});
      lean[id] = this.trackers[id].read(t);
      signals[correctedKey(id)] = correctedLean(answered, lean[id]);
      if (probabilities[id]) this.trackers[id].push(t, answered);
    }
    return { lean, signals };
  }
}

/**
 * Give every record its reading. Records from before this existed, and backtests (which ask about
 * many snapshots at once, out of order), have none; they get exactly what a live run would have
 * worked out, by going through the answers in the order they arrived. A reading a record already
 * has is left alone. `recs` must be in arrival order.
 */
export function fillLeans(recs: DecisionRecord[], book = new LeanBook()): DecisionRecord[] {
  for (const rec of recs) {
    if (!rec.probabilities) continue; // Jev was not asked (D63): there is no lean to read
    const read = book.take(rec.tResp, rec.probabilities);
    if (rec.lean) continue;
    rec.lean = read.lean;
    Object.assign(rec.signals, read.signals);
  }
  return recs;
}
