// What trading on Jev's answers would have made, under three rules, next to the order-book model.
//
// "asAnswered" takes Jev's answers at face value: when Jev leans a way, take that side at the
// price its answer arrived at, hold for the horizon, close at the mid, all the same size. It is
// kept as the yardstick the other two are measured against.
//
// "corrected" is the same rule with Jev's usual lean taken out first (src/model/lean.ts). Jev
// leans "down" most of the time whatever the market is about to do, so at face value four trades
// in five were shorts; read against its own recent answers, its calls split evenly and were right
// noticeably more often.
//
// "selective" trades the corrected lean only when the best level of the order book points the
// same way, sits out if a headline from the last few minutes leans the other way, and stakes more
// on a stronger lean. When Jev and the book disagreed, Jev was right less than half the time, so
// its dissent is not worth acting on (docs/decisions.md D51).
//
// "orderBook" trades the order-book model (src/model/ridge.ts) instead of Jev, and at 10 s only
// in the calm markets where the model was right most often (docs/accuracy.md).
//
// Every rule weighs the cost before it trades: a call is taken only when it is expected to catch
// more than the round trip costs, the exchange's fee on the way in and on the way out plus the
// spread (src/model/costs.ts). The order-book model says how far it expects the price to move.
// Jev doesn't, so its calls are judged by their track record: what earlier calls of about the
// same strength caught, less a margin for luck (src/dashboard/track.ts, docs/decisions.md D59).
// At a taker's fees that is almost never, which is the finding, not a fault. What every call
// would have made, traded whatever it cost, is kept beside each rule, so a signal that is right
// but too small to trade can be told from one that is simply wrong.
//
// No rule looks at how the run turned out before deciding what to trade, which is the difference
// between this and the "net edge" in the report (src/analyze.ts): that one sorts the whole run
// into quintiles to find its strongest signals, and you could only do that afterwards.

import type { DecisionRecord } from '../engine.ts';
import { bps, num } from '../lib/stats.ts';
import { roundTripBps } from '../model/costs.ts';
import { DIRECTIONS } from '../model/jev.ts';
import { calmEnough, orderBookModels, type RidgeModel } from '../model/ridge.ts';
import type { NewsRecord } from '../news/engine.ts';
import type { Pnl, PnlLeg, PnlSet, Reach } from './collector.ts';
import { expectations, jevCall, TrackRecord, type JevRule } from './track.ts';

/** Points kept for drawing the running total: enough for a smooth line, small enough to send often. */
const CURVE_POINTS = 240;
/** The most the selective rule stakes on one call, however strong the lean: twice the normal stake. */
const MAX_STAKE = 2;
/** How long a headline's lean still counts as "recent" when deciding whether to trade. */
const NEWS_LOOKBACK_MS = 15 * 60_000;
/** Extra size when a recent, relevant headline leans the same way Jev does. */
const NEWS_AGREEMENT_BOOST = 0.25;

const HORIZONS: number[] = Object.values(DIRECTIONS).map(d => d.seconds);

export type PnlOptions = {
  /** The exchange's fee on each fill, in bps; a round trip pays it twice, and the spread on top. */
  feeBpsPerSide: number;
  /** Stake per trade at full size, so the result can be shown in money as well as basis points. */
  notionalUsd: number;
  /** The instrument being traded, so a headline about something else is never mistaken for a fundamental opinion. */
  product: string;
};

/** A trade to take, and how much of a full-size stake to put on it; null means sit this one out. */
type Decision = { dir: 1 | -1; sizeFraction: number } | null;

/**
 * A way of trading: the call it would make on a decision, whatever that would cost, and what it
 * expects the call to catch in the call's own direction, in bps. NaN when it can't say, or, for
 * the order-book model at 10 s, won't in this market.
 */
type Rule = {
  call: (rec: DecisionRecord, horizonS: number) => Decision;
  expects: (rec: DecisionRecord, horizonS: number) => number;
};

/** A lean worth trading: a number that points one way or the other. */
function direction(signal: unknown): 1 | -1 | null {
  return typeof signal === 'number' && Number.isFinite(signal) && signal !== 0 ? (Math.sign(signal) as 1 | -1) : null;
}

/**
 * Jev's call under one of its rules, before the cost is weighed. `news` must already be about the
 * traded instrument and sorted ascending by `tResp`. Only records with `tResp <= rec.tState` are
 * ever looked at, so a headline is never used before its answer actually existed.
 */
function jevDecision(rule: JevRule, rec: DecisionRecord, horizonS: number, news: readonly NewsRecord[]): Decision {
  const call = jevCall(rec, rule, horizonS);
  if (!call) return null;
  if (rule !== 'selective') return { dir: call.dir, sizeFraction: 1 };

  const latest = news.findLast(n => n.tResp <= rec.tState);
  const newsDir = latest && rec.tState - latest.tResp <= NEWS_LOOKBACK_MS ? Math.sign(latest.signal) : 0;
  if (newsDir !== 0 && newsDir !== call.dir) return null; // a fresh headline says the other way

  // Staked in proportion to how strong the lean is next to Jev's ordinary one, so an ordinary
  // lean is one normal stake. TypeSafe's confidence is deliberately not used: it is the
  // probability of the answer Jev picked, which is usually "flat", so it is highest exactly when
  // Jev expects nothing to happen.
  if (Number.isNaN(call.strength)) return null;
  const sizeFraction = Math.min(MAX_STAKE, call.strength) * (newsDir === call.dir ? 1 + NEWS_AGREEMENT_BOOST : 1);
  return { dir: call.dir, sizeFraction };
}

/** One of Jev's rules, expecting of each call what earlier calls like it caught. */
function jevRule(rule: JevRule, recs: readonly DecisionRecord[], track: TrackRecord, news: readonly NewsRecord[]): Rule {
  const expected = new Map(HORIZONS.map(h => [h, expectations(recs, rule, h, track)]));
  return {
    call: (rec, horizonS) => jevDecision(rule, rec, horizonS, news),
    expects: (rec, horizonS) => expected.get(horizonS)?.get(rec) ?? NaN,
  };
}

/** The order-book model's call and the move it expects, heard only in a calm market where its model says so. */
function orderBookRule(models: readonly RidgeModel[]): Rule {
  return {
    call: (rec, horizonS) => {
      const dir = direction(rec.signals[`ob_${horizonS}s`]);
      return dir ? { dir, sizeFraction: 1 } : null;
    },
    expects: (rec, horizonS) => {
      const model = models.find(m => m.horizonS === horizonS);
      if (model && !calmEnough(model, rec.vol60, rec.quote ? rec.quote.ask - rec.quote.bid : undefined)) return NaN;
      return Math.abs(num(rec.signals[`ob_${horizonS}s`]));
    },
  };
}

/** Evenly spaced points, keeping the first and the last. */
function thin<T>(xs: T[], most: number): T[] {
  if (xs.length <= most) return xs;
  const step = (xs.length - 1) / (most - 1);
  return Array.from({ length: most }, (_, i) => xs[Math.round(i * step)]!);
}

function leg(recs: readonly DecisionRecord[], horizonS: number, feeBpsPerSide: number, decide: (rec: DecisionRecord, horizonS: number) => Decision): PnlLeg {
  const curve: { t: number; cumBps: number }[] = [];
  let total = 0;
  let gross = 0;
  let costs = 0;
  let staked = 0;
  let peak = 0;
  let drawdown = 0;
  let wins = 0;
  let losses = 0;
  let right = 0;
  let wrong = 0;
  let best: number | null = null;
  let worst: number | null = null;

  for (const rec of recs) {
    const decision = decide(rec, horizonS);
    if (!decision) continue;
    const move = bps(rec.fwdResp[horizonS], rec.midResp);
    if (!Number.isFinite(move)) continue; // the horizon hasn't finished yet
    // Unweighted: what the call itself was worth, so "best"/"worst" describe the call, not the stake.
    const cost = roundTripBps(rec, feeBpsPerSide);
    const gotBps = decision.dir * move - cost;
    gross += decision.dir * move * decision.sizeFraction;
    costs += cost * decision.sizeFraction;
    if (gotBps > 0) wins++;
    else if (gotBps < 0) losses++;
    if (decision.dir * move > 0) right++;
    else if (decision.dir * move < 0) wrong++;
    best = best === null ? gotBps : Math.max(best, gotBps);
    worst = worst === null ? gotBps : Math.min(worst, gotBps);
    total += gotBps * decision.sizeFraction;
    staked += decision.sizeFraction;
    peak = Math.max(peak, total);
    drawdown = Math.max(drawdown, peak - total);
    curve.push({ t: rec.tResp, cumBps: total });
  }

  const trades = curve.length;
  return {
    horizonS,
    trades,
    wins,
    losses,
    right,
    wrong,
    totalBps: total,
    grossBps: gross,
    costBps: costs,
    staked,
    // Per normal stake put down, not per trade, so a rule is not marked down for betting smaller.
    avgBps: staked > 0 ? total / staked : null,
    bestBps: best,
    worstBps: worst,
    maxDrawdownBps: drawdown,
    curve: thin(curve, CURVE_POINTS),
  };
}

/**
 * How near a rule came to trading at one horizon: every call it made whose outcome is known,
 * traded whatever it cost, and the calls it could weigh against the cost, with the most any of
 * those was expected to catch and what a round trip cost on average among them.
 */
function reach(recs: readonly DecisionRecord[], horizonS: number, feeBpsPerSide: number, rule: Rule): Reach {
  const every = leg(recs, horizonS, feeBpsPerSide, rule.call);
  let weighed = 0;
  let largest: number | null = null;
  let costs = 0;
  for (const rec of recs) {
    if (!rule.call(rec, horizonS) || !Number.isFinite(bps(rec.fwdResp[horizonS], rec.midResp))) continue;
    const expected = rule.expects(rec, horizonS);
    if (!Number.isFinite(expected)) continue;
    weighed++;
    largest = Math.max(largest ?? -Infinity, expected);
    costs += roundTripBps(rec, feeBpsPerSide);
  }
  const { trades: calls, right, wrong, grossBps, costBps, staked } = every;
  return { horizonS, calls, right, wrong, grossBps, costBps, staked, weighed, largestBps: largest, meanCostBps: weighed > 0 ? costs / weighed : null };
}

function report(recs: readonly DecisionRecord[], { feeBpsPerSide, notionalUsd }: PnlOptions, rule: Rule): Pnl {
  const traded = (rec: DecisionRecord, horizonS: number): Decision => {
    const decision = rule.call(rec, horizonS);
    return decision && rule.expects(rec, horizonS) > roundTripBps(rec, feeBpsPerSide) ? decision : null; // otherwise it would not pay for itself
  };
  return {
    n: recs.length,
    since: recs.length > 0 ? Math.min(...recs.map(r => r.tState)) : null,
    feeBpsPerSide,
    notionalUsd,
    legs: HORIZONS.map(h => leg(recs, h, feeBpsPerSide, traded)),
    reach: HORIZONS.map(h => reach(recs, h, feeBpsPerSide, rule)),
  };
}

/**
 * All four rules over the same finished decisions, in the order they were made. `news` can be
 * every finished news record the dashboard has kept, about any instrument; only ones matching
 * `opts.product` are ever looked at. It can be empty (most sources publish only a few times an
 * hour, so long quiet stretches are normal) and the selective rule simply never gets a
 * fundamental opinion during them. `models` are the order-book models whose calm condition the
 * orderBook rule follows. `track` holds Jev's finished calls; it can reach back before `recs`,
 * so the first of them are judged by as long a record as the last, and left out it is made from
 * `recs` alone.
 */
export function pnlReport(
  recs: readonly DecisionRecord[],
  opts: PnlOptions,
  news: readonly NewsRecord[] = [],
  models: readonly RidgeModel[] = orderBookModels,
  track: TrackRecord = TrackRecord.from(recs),
): PnlSet {
  const relevant = news.filter(n => n.symbol === opts.product);
  return {
    asAnswered: report(recs, opts, jevRule('asAnswered', recs, track, relevant)),
    corrected: report(recs, opts, jevRule('corrected', recs, track, relevant)),
    selective: report(recs, opts, jevRule('selective', recs, track, relevant)),
    orderBook: report(recs, opts, orderBookRule(models)),
  };
}
