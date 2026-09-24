// What trading on Jev's answers would have made, under three rules.
//
// "asAnswered" takes every answer at face value: when Jev leans a way, take that side at the price
// its answer arrived at, hold for the horizon, close at the mid. Every lean is traded, all the
// same size. It is kept as the yardstick the other two are measured against.
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
// "orderBook" trades the order-book model (src/model/ridge.ts) instead of Jev. It is the only
// rule that looks at the cost before trading: the model says how far it expects the price to
// move, so a call is taken only when that is more than the round trip would cost, and at 10 s
// only in the calm markets where the model was right most often (docs/accuracy.md). At any fee
// Coinbase publishes that is almost never, which is the finding, not a fault.
//
// Every rule pays for every trade: the exchange's fee on the way in and on the way out, and the
// spread (src/model/costs.ts). Each leg also keeps what the moves alone were worth, so a signal
// that is right but too small to trade can be told from one that is simply wrong.
//
// No rule looks at how the run turned out before deciding what to trade, which is the difference
// between this and the "net edge" in the report (src/analyze.ts): that one sorts the whole run
// into quintiles to find its strongest signals, and you could only do that afterwards.

import type { DecisionRecord } from '../engine.ts';
import { bps, num } from '../lib/stats.ts';
import { roundTripBps } from '../model/costs.ts';
import { DIRECTIONS, type DirectionId } from '../model/jev.ts';
import { conviction } from '../model/lean.ts';
import { calmEnough, orderBookModels, type RidgeModel } from '../model/ridge.ts';
import type { NewsRecord } from '../news/engine.ts';
import type { OrderBookReach, Pnl, PnlLeg, PnlSet } from './collector.ts';

/** Points kept for drawing the running total: enough for a smooth line, small enough to send often. */
const CURVE_POINTS = 240;
/** The most the selective rule stakes on one call, however strong the lean: twice the normal stake. */
const MAX_STAKE = 2;
/** How long a headline's lean still counts as "recent" when deciding whether to trade. */
const NEWS_LOOKBACK_MS = 15 * 60_000;
/** Extra size when a recent, relevant headline leans the same way Jev does. */
const NEWS_AGREEMENT_BOOST = 0.25;

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

/** A lean worth trading: a number that points one way or the other. */
function direction(signal: unknown): 1 | -1 | null {
  return typeof signal === 'number' && Number.isFinite(signal) && signal !== 0 ? (Math.sign(signal) as 1 | -1) : null;
}

function asAnsweredDecision(rec: DecisionRecord, horizonS: number): Decision {
  const dir = direction(rec.signals[`jev_${horizonS}s`]);
  return dir ? { dir, sizeFraction: 1 } : null;
}

/** While Jev's usual lean is not known yet (the first minute of a run) there is no corrected lean, and so no trade. */
function correctedDecision(rec: DecisionRecord, horizonS: number): Decision {
  const dir = direction(rec.signals[`jevc_${horizonS}s`]);
  return dir ? { dir, sizeFraction: 1 } : null;
}

/**
 * `news` must already be about the traded instrument and sorted ascending by `tResp`. Only records
 * with `tResp <= rec.tState` are ever looked at, so a headline is never used before its answer
 * actually existed.
 */
function selectiveDecision(rec: DecisionRecord, horizonS: number, news: readonly NewsRecord[]): Decision {
  const corrected = rec.signals[`jevc_${horizonS}s`];
  const dir = direction(corrected);
  if (!dir) return null;

  if (Math.sign(num(rec.signals.obi1)) !== dir) return null; // the best level of the book does not back this call up

  const recent = news.findLast(n => n.tResp <= rec.tState && rec.tState - n.tResp <= NEWS_LOOKBACK_MS);
  const newsDir = recent ? Math.sign(recent.signal) : 0;
  if (newsDir !== 0 && newsDir !== dir) return null; // a fresh headline says the other way

  // Staked in proportion to how strong the lean is next to Jev's ordinary one, so an ordinary
  // lean is one normal stake. TypeSafe's confidence is deliberately not used: it is the
  // probability of the answer Jev picked, which is usually "flat", so it is highest exactly when
  // Jev expects nothing to happen.
  const strength = conviction(corrected as number, rec.lean?.[`dir_${horizonS}s` as DirectionId]);
  if (Number.isNaN(strength)) return null;
  const sizeFraction = Math.min(MAX_STAKE, strength) * (newsDir === dir ? 1 + NEWS_AGREEMENT_BOOST : 1);
  return { dir, sizeFraction };
}

/**
 * The order-book model's call, taken only when the move it expects is bigger than what the
 * round trip would cost, and, where its model says so, only in a calm market.
 */
function orderBookDecision(rec: DecisionRecord, horizonS: number, feeBpsPerSide: number, models: readonly RidgeModel[]): Decision {
  const expected = rec.signals[`ob_${horizonS}s`];
  const dir = direction(expected);
  if (!dir) return null;
  const model = models.find(m => m.horizonS === horizonS);
  if (model && !calmEnough(model, rec.vol60, rec.quote ? rec.quote.ask - rec.quote.bid : undefined)) return null;
  if (Math.abs(expected as number) <= roundTripBps(rec, feeBpsPerSide)) return null; // it would not pay for itself
  return { dir, sizeFraction: 1 };
}

function orderBookReach(recs: DecisionRecord[], horizonS: number, feeBpsPerSide: number, models: readonly RidgeModel[]): OrderBookReach {
  const model = models.find(m => m.horizonS === horizonS);
  let calls = 0;
  let calm = 0;
  let largest: number | null = null;
  let costs = 0;
  for (const rec of recs) {
    const expected = rec.signals[`ob_${horizonS}s`];
    if (typeof expected !== 'number' || !Number.isFinite(expected)) continue;
    calls++;
    if (model && !calmEnough(model, rec.vol60, rec.quote ? rec.quote.ask - rec.quote.bid : undefined)) continue;
    calm++;
    largest = Math.max(largest ?? 0, Math.abs(expected));
    costs += roundTripBps(rec, feeBpsPerSide);
  }
  return { horizonS, calls, calm, largestBps: largest, meanCostBps: calm > 0 ? costs / calm : null };
}

/** Evenly spaced points, keeping the first and the last. */
function thin<T>(xs: T[], most: number): T[] {
  if (xs.length <= most) return xs;
  const step = (xs.length - 1) / (most - 1);
  return Array.from({ length: most }, (_, i) => xs[Math.round(i * step)]!);
}

function leg(recs: DecisionRecord[], horizonS: number, feeBpsPerSide: number, decide: (rec: DecisionRecord, horizonS: number) => Decision): PnlLeg {
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

function report(recs: DecisionRecord[], { feeBpsPerSide, notionalUsd }: PnlOptions, decide: (rec: DecisionRecord, horizonS: number) => Decision): Pnl {
  return {
    n: recs.length,
    since: recs.length > 0 ? Math.min(...recs.map(r => r.tState)) : null,
    feeBpsPerSide,
    notionalUsd,
    legs: Object.values(DIRECTIONS).map(d => leg(recs, d.seconds, feeBpsPerSide, decide)),
  };
}

/**
 * All four rules over the same finished decisions. `news` can be every finished news record the
 * dashboard has kept, about any instrument; only ones matching `opts.product` are ever looked at.
 * It can be empty (most sources publish only a few times an hour, so long quiet stretches are
 * normal) and the selective rule simply never gets a fundamental opinion during them. `models`
 * are the order-book models whose calm condition the orderBook rule follows.
 */
export function pnlReport(recs: DecisionRecord[], opts: PnlOptions, news: readonly NewsRecord[] = [], models: readonly RidgeModel[] = orderBookModels): PnlSet {
  const relevant = news.filter(n => n.symbol === opts.product);
  return {
    asAnswered: report(recs, opts, asAnsweredDecision),
    corrected: report(recs, opts, correctedDecision),
    selective: report(recs, opts, (rec, h) => selectiveDecision(rec, h, relevant)),
    orderBook: report(recs, opts, (rec, h) => orderBookDecision(rec, h, opts.feeBpsPerSide, models)),
    orderBookReach: Object.values(DIRECTIONS).map(d => orderBookReach(recs, d.seconds, opts.feeBpsPerSide, models)),
  };
}
