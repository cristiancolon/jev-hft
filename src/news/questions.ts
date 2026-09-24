// What Jev is asked about each news item, and the state it sees.
//
// One call per item. For each instrument the item is routed to, three questions: relevance
// and magnitude are "will this matter" (volatility), direction is "which way". Novelty is about
// the item itself, so it is asked once; it filters recaps and price reports that describe moves
// that already happened. TypeSafe evaluates all questions in parallel, so extra instruments cost
// tokens, not latency.
//
// The questions name the same time span the pipeline measures afterwards (its longest horizon),
// so an answer is judged against exactly what was asked.

import type { Experimental_EvaluationQuestion as Question } from 'ai';
import { bps } from '../lib/stats.ts';
import type { Prices } from '../market/prices.ts';
import { usSession, type AssetClass, type Instrument } from './instruments.ts';
import type { EarlierHeadline } from './memory.ts';
import type { NewsItem } from './types.ts';

/** Magnitude rubric per asset class: stocks routinely move more on their own news than Bitcoin. */
const MAGNITUDE: Record<AssetClass, string[]> = {
  crypto: ['Negligible', 'Small: under 0.2%', 'Moderate: 0.2% to 1%', 'Large: over 1%'],
  equity: ['Negligible', 'Small: under 0.5%', 'Moderate: 0.5% to 2%', 'Large: over 2%'],
};

/**
 * The same rubric as a move in bps, one number per level: nothing, the middle of each bounded
 * range, and one and a half times the bound for the open-ended top one. This is what turns Jev's
 * answer into a size that can be weighed against the cost of a trade (src/dashboard/pnl.ts).
 */
const MAGNITUDE_BPS: Record<AssetClass, number[]> = {
  crypto: [0, 10, 60, 150],
  equity: [0, 25, 125, 300],
};

/**
 * The move Jev expects in the direction it leans, in bps: the chance the news matters, times how
 * much more bullish than bearish it is, times the size its magnitude answer (0 to 3, a weighted
 * average of the levels) stands for, read between the levels in a straight line.
 */
export function expectedMoveBps(assetClass: AssetClass, signal: number, magnitude: number): number {
  const sizes = MAGNITUDE_BPS[assetClass];
  const m = Math.min(Math.max(magnitude, 0), sizes.length - 1);
  const below = Math.min(Math.floor(m), sizes.length - 2);
  const size = sizes[below]! + (m - below) * (sizes[below + 1]! - sizes[below]!);
  return Math.abs(signal) * size;
}

/** "30 minutes", "90 seconds", "1 hour": the measured time span in words. */
export function spanWords(seconds: number) {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (seconds % 3600 === 0) return plural(seconds / 3600, 'hour');
  if (seconds % 60 === 0) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}

/**
 * Question ids: `novel`, then `relevant_<i>`, `direction_<i>`, `magnitude_<i>` per instrument index.
 * `hasEarlier` says whether the state lists earlier headlines, so the novelty question can point at them.
 */
export function newsQuestions(instruments: Instrument[], horizonS: number, hasEarlier: boolean): Record<string, Question> {
  const span = spanWords(horizonS);
  const questions: Record<string, Question> = {
    novel: {
      type: 'boolean',
      instructions:
        'Is this new information, rather than a recap, opinion, price report, or follow-up on news that is already known?' +
        (hasEarlier ? ' Anything listed under earlier_related_headlines is already known.' : ''),
    },
  };
  instruments.forEach((ins, i) => {
    questions[`relevant_${i}`] = {
      type: 'boolean',
      instructions: `Could this news plausibly move the price of ${ins.name} within the next ${span}?`,
    };
    questions[`direction_${i}`] = {
      type: 'choice',
      instructions: `If this news moves ${ins.name}, which way would it push the price?`,
      criteria: { bullish: 'Price rises', bearish: 'Price falls', neutral: 'No clear direction' },
    };
    questions[`magnitude_${i}`] = {
      type: 'score',
      instructions: `How large a ${ins.name} price reaction could this news cause within the next ${span}?`,
      criteria: MAGNITUDE[ins.assetClass],
    };
  });
  return questions;
}

/** Directional signal: relevance-weighted P(bullish) - P(bearish). */
export const newsSignal = (relevant: number, direction: Record<string, number>) =>
  relevant * ((direction.bullish ?? 0) - (direction.bearish ?? 0));

const fmtBp = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)}bp` : 'n/a');
const fmtPct = (x: number) => `${x >= 0 ? '+' : ''}${(x / 100).toFixed(2)}%`;

/** The state for one item: the text, how stale it is, what came before, and what each instrument has been doing. */
export function newsState(item: NewsItem, instruments: Instrument[], prices: Prices, earlier: EarlierHeadline[], now: number) {
  return {
    headline: item.headline,
    ...(item.summary ? { summary: item.summary } : {}),
    source: item.sourceLabel ?? item.source,
    published: item.publishedTs ? `${new Date(item.publishedTs).toISOString().slice(0, 16)}Z` : 'unknown',
    minutes_since_published: item.publishedTs ? Math.max(0, Math.round((now - item.publishedTs) / 60_000)) : 'unknown',
    markets: Object.fromEntries(instruments.map(ins => [ins.symbol, marketLine(ins, prices, now)])),
    ...(earlier.length > 0 ? { earlier_related_headlines: earlier } : {}),
  };
}

function marketLine(ins: Instrument, prices: Prices, now: number): string {
  const mid = prices.mid(ins.symbol);
  if (!Number.isFinite(mid)) return `${ins.name}: no recent price`;
  const change = (seconds: number) => fmtBp(bps(mid, prices.midAt(ins.symbol, now - seconds * 1000)));
  // Stock quotes can be very wide outside regular hours (IEX-only data especially); the spread
  // tells the model how much to trust the price.
  const quality = ins.assetClass === 'equity' ? ` (quote spread ${prices.spreadBps(ins.symbol).toFixed(0)}bp), US session ${usSession(now)}` : '';
  // A stock that is already up 12% on the day is the clearest sign that news is priced in.
  const close = prices.lastClose(ins.symbol);
  const sinceClose = Number.isFinite(close) ? `since last close ${fmtPct(bps(mid, close))}, ` : '';
  return `${ins.name} ${mid.toFixed(2)}${quality}; change ${sinceClose}over last 1m ${change(60)}, 5m ${change(300)}, 30m ${change(1800)}`;
}
