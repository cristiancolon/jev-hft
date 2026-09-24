// What Jev's earlier calls caught, so the dashboard can tell whether a new one is worth its cost.
//
// Jev says which way it leans, not how far the price will move, so nothing it says can be weighed
// against the cost of a trade. Its track record can: how much earlier calls of about the same
// strength actually caught. A call is traded only when calls like it, over the last four hours,
// caught more than the round trip costs, by enough that luck is an unlikely explanation
// (docs/decisions.md D59).
//
// Three things keep this honest:
// - Only calls whose outcome was already known when the new call was made count. A 60 s call
//   made 30 s earlier has not finished, so it can't count yet.
// - "About the same strength" is a band of conviction (src/model/lean.ts): under half an ordinary
//   lean, up to one, up to two, and beyond. Stronger leans caught more on every day measured, so
//   pooling them would overrate the weak calls and underrate the strong ones.
// - Luck is judged by how much the price moved, and by how many separate outcomes there really
//   were. Calls a second apart share most of the same move: over 60 s, sixty calls in a row are
//   barely more evidence than one. So a band's calls count as separate only once per horizon of
//   time they cover.

import type { DecisionRecord } from '../engine.ts';
import { bps, num } from '../lib/stats.ts';
import { DIRECTIONS, type DirectionId } from '../model/jev.ts';
import { conviction } from '../model/lean.ts';

/** How far back the track record reaches. Four hours gave fewer lucky-looking bands than one or two, over 77 hours of calls. */
export const TRACK_WINDOW_MS = 4 * 60 * 60_000;
/** Where one strength band ends and the next begins, in ordinary leans. */
export const STRENGTH_BANDS = [0.5, 1, 2] as const;
/** Fewer earlier calls than this in a band and there is nothing to judge by. */
export const MIN_TRACK_CALLS = 50;
/** How many standard errors below its band's average a call is counted on to catch. */
export const LUCK_MARGIN = 2;

/**
 * The three ways the dashboard trades Jev (src/dashboard/pnl.ts): its answers at face value, with
 * its usual lean taken out, and the corrected lean only when the order book agrees.
 */
export type JevRule = 'asAnswered' | 'corrected' | 'selective';
export const JEV_RULES: readonly JevRule[] = ['asAnswered', 'corrected', 'selective'];

/** A Jev call before any cost is thought of: which way, and how strong next to Jev's typical lean (NaN while that is unknown). */
export type JevCall = { dir: 1 | -1; strength: number };

/** One finished call, reduced to what the track record needs: when it was made, how strong it was, and what it caught. */
export type PastCall = { t: number; strength: number; caughtBps: number };

/**
 * The call a rule makes on a decision, or null for none. A headline can still stop the selective
 * rule from trading it, but that is left out here: headlines are too rare to split the track
 * record by.
 */
export function jevCall(rec: DecisionRecord, rule: JevRule, horizonS: number): JevCall | null {
  const lean = rec.signals[rule === 'asAnswered' ? `jev_${horizonS}s` : `jevc_${horizonS}s`];
  if (typeof lean !== 'number' || !Number.isFinite(lean) || lean === 0) return null;
  const dir = Math.sign(lean) as 1 | -1;
  if (rule === 'selective' && Math.sign(num(rec.signals.obi1)) !== dir) return null; // the best level of the book does not back this call up
  return { dir, strength: conviction(lean, rec.lean?.[`dir_${horizonS}s` as DirectionId]) };
}

const band = (strength: number) => {
  let b = 0;
  while (b < STRENGTH_BANDS.length && strength >= STRENGTH_BANDS[b]!) b++;
  return b;
};

/** Every finished call of the last few hours, per rule and horizon, oldest first. */
export class TrackRecord {
  private readonly lists = new Map<string, PastCall[]>();

  /** A record made from `recs` alone, for when there is no longer history to draw on. */
  static from(recs: readonly DecisionRecord[]): TrackRecord {
    const track = new TrackRecord();
    for (const rec of recs) track.add(rec);
    return track;
  }

  /** Add a finished decision's calls. Decisions must come in the order they were made. */
  add(rec: DecisionRecord) {
    for (const rule of JEV_RULES) {
      for (const { seconds } of Object.values(DIRECTIONS)) {
        const call = jevCall(rec, rule, seconds);
        const move = bps(rec.fwdResp[seconds], rec.midResp);
        if (!call || Number.isNaN(call.strength) || !Number.isFinite(move)) continue;
        this.calls(rule, seconds).push({ t: rec.tResp, strength: call.strength, caughtBps: call.dir * move });
      }
    }
  }

  /** Forget calls made before `t`. */
  forget(t: number) {
    for (const list of this.lists.values()) {
      let old = 0;
      while (old < list.length && list[old]!.t < t) old++;
      if (old > 0) list.splice(0, old);
    }
  }

  calls(rule: JevRule, horizonS: number): PastCall[] {
    const key = `${rule}:${horizonS}`;
    let list = this.lists.get(key);
    if (!list) this.lists.set(key, (list = []));
    return list;
  }
}

/** The finished calls of one rule at one horizon over a trailing window, by strength band. */
class Bands {
  private readonly count = STRENGTH_BANDS.map(() => 0).concat(0);
  private readonly sum = this.count.map(() => 0);
  private readonly squares = this.count.map(() => 0);
  /** When each band's calls were made, and where the ones still in the window start. */
  private readonly times: number[][] = this.count.map(() => []);
  private readonly first = this.count.map(() => 0);
  private readonly horizonS: number;

  constructor(horizonS: number) {
    this.horizonS = horizonS;
  }

  add(c: PastCall) {
    const b = band(c.strength);
    this.count[b]!++;
    this.sum[b]! += c.caughtBps;
    this.squares[b]! += c.caughtBps * c.caughtBps;
    this.times[b]!.push(c.t);
  }

  drop(c: PastCall) {
    const b = band(c.strength);
    this.count[b]!--;
    this.sum[b]! -= c.caughtBps;
    this.squares[b]! -= c.caughtBps * c.caughtBps;
    this.first[b]!++;
  }

  /** What a call of this strength can be counted on to catch: its band's average, less the margin for luck. NaN with too few calls to judge by. */
  expect(strength: number): number {
    const b = band(strength);
    const n = this.count[b]!;
    if (n < MIN_TRACK_CALLS) return NaN;
    const mean = this.sum[b]! / n;
    const variance = Math.max(0, this.squares[b]! / n - mean * mean);
    const times = this.times[b]!;
    const coveredS = (times[times.length - 1]! - times[this.first[b]!]!) / 1000;
    const separate = Math.min(n, coveredS / this.horizonS + 1);
    return mean - LUCK_MARGIN * Math.sqrt(variance / separate);
  }
}

/**
 * What each call `rule` makes in `recs` at `horizonS` could be counted on to catch, in bps in the
 * call's own direction, learnt only from the calls in `track` that had finished by the time it was
 * made. NaN where there were too few to judge by; no entry where the rule made no call. `recs`
 * must be in the order they were made, and so must the track record's calls.
 */
export function expectations(recs: readonly DecisionRecord[], rule: JevRule, horizonS: number, track: TrackRecord): Map<DecisionRecord, number> {
  const past = track.calls(rule, horizonS);
  const bands = new Bands(horizonS);
  const out = new Map<DecisionRecord, number>();
  let learnt = 0; // calls folded in so far
  let dropped = 0; // and dropped again for being older than the window
  for (const rec of recs) {
    while (learnt < past.length && past[learnt]!.t + horizonS * 1000 <= rec.tResp) bands.add(past[learnt++]!);
    while (dropped < learnt && past[dropped]!.t < rec.tResp - TRACK_WINDOW_MS) bands.drop(past[dropped++]!);
    const call = jevCall(rec, rule, horizonS);
    if (call) out.set(rec, Number.isNaN(call.strength) ? NaN : bands.expect(call.strength));
  }
  return out;
}
