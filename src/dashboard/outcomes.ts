// Turns the pipeline's finished records into "what happened next" for the dashboard, and keeps
// the live scoreboard of Jev against the simple rules. Runs only in the dashboard server.
//
// The scoring follows the report (src/analyze.ts): Jev is judged from when its answer arrived,
// because that is what could have been traded; the simple rules are judged from the snapshot,
// because they take no time to compute.

import type { DecisionRecord } from '../engine.ts';
import { bps, partialSpearman, spearman } from '../lib/stats.ts';
import { DIRECTIONS } from '../model/jev.ts';
import type { NewsRecord } from '../news/engine.ts';
import { tradableMove } from '../news/moves.ts';
import type { NewsItem } from '../news/types.ts';
import type { LiveOutcome, NewsEntry, NewsOutcome, Scoreboard, ScoreCell } from './collector.ts';

const orNull = (x: number) => (Number.isFinite(x) ? x : null);

export function liveOutcome(rec: DecisionRecord): LiveOutcome {
  const moves = (fwd: Record<number, number>, from: number) => Object.fromEntries(Object.keys(fwd).map(h => [h, orNull(bps(fwd[Number(h)], from))]));
  return { type: 'outcome', program: 'live', tState: rec.tState, fromState: moves(rec.fwdState, rec.midState), fromResp: moves(rec.fwdResp, rec.midResp) };
}

export function newsOutcome(rec: NewsRecord, maxSpreadBps: number): NewsOutcome {
  const moves = Object.fromEntries(Object.keys(rec.fwdResp).map(h => [h, orNull(tradableMove(rec, Number(h), maxSpreadBps))]));
  return { type: 'news-outcome', program: 'news', id: rec.item.id, recvTs: rec.item.recvTs, symbol: rec.symbol, moves };
}

/**
 * A feed entry for a headline that arrived before the dashboard was listening: the item as the
 * pipeline saved it, plus Jev's answer if finished records for it exist (one per instrument).
 */
export function restoredEntry(item: NewsItem, recs: NewsRecord[]): NewsEntry {
  const base = {
    id: item.id,
    run: 0,
    source: item.source,
    sourceLabel: item.sourceLabel ?? item.source,
    headline: item.headline,
    url: item.url ?? null,
    publishedTs: item.publishedTs ?? null,
    recvTs: item.recvTs,
    symbols: item.symbols ?? null,
  };
  const first = recs[0];
  if (!first) return { ...base, status: 'earlier' };
  return {
    ...base,
    status: 'answered',
    answer: {
      tResp: first.tResp,
      queueMs: first.queueMs,
      modelMs: first.modelMs,
      providerMs: first.providerMs ?? null,
      costUsd: first.costUsd ?? null,
      attempts: first.attempts ?? 1,
      novel: first.novel,
      verdicts: recs.map(r => ({ symbol: r.symbol, name: r.symbol, relevant: r.relevant, direction: r.direction, magnitude: r.magnitude, signal: r.signal, mid: orNull(r.midResp), spreadBps: orNull(r.spreadBps) })),
      state: first.state,
    },
  };
}

const RULES: [key: string, label: string][] = [
  ['obi1', 'Book imbalance, best level'],
  ['obi5', 'Book imbalance, 5 levels'],
  ['flow5', 'Buying − selling, 5 s'],
  ['mom5', 'Price change, 5 s'],
];

function cell(horizonS: number, signal: number[], move: number[]): ScoreCell {
  const pairs = signal.map((s, i) => [s, move[i]!] as const).filter(([s, m]) => Number.isFinite(s) && Number.isFinite(m));
  const decided = pairs.filter(([s, m]) => s !== 0 && m !== 0);
  const hits = decided.filter(([s, m]) => Math.sign(s) === Math.sign(m)).length;
  return { horizonS, hit: decided.length > 0 ? hits / decided.length : null, ic: orNull(spearman(pairs.map(p => p[0]), pairs.map(p => p[1]))), n: pairs.length, judged: decided.length };
}

/** How often each signal pointed the right way over these finished decisions, and how well it ranked the moves. */
export function scoreboard(recs: DecisionRecord[]): Scoreboard {
  const horizons = Object.values(DIRECTIONS).map(d => d.seconds);
  const fromState = (h: number) => recs.map(r => bps(r.fwdState[h], r.midState));
  const fromResp = (h: number) => recs.map(r => bps(r.fwdResp[h], r.midResp));
  const signal = (key: string) => recs.map(r => (typeof r.signals[key] === 'number' ? r.signals[key]! : NaN));
  return {
    n: recs.length,
    since: recs.length > 0 ? Math.min(...recs.map(r => r.tState)) : null,
    horizons,
    rows: [
      // Jev twice: read against its own usual lean, which is what the pipeline acts on, and at face value.
      { key: 'jevc', label: 'Jev, usual lean taken out', isJev: true, cells: horizons.map(h => cell(h, signal(`jevc_${h}s`), fromResp(h))) },
      { key: 'jev', label: 'Jev, as answered', isJev: false, cells: horizons.map(h => cell(h, signal(`jev_${h}s`), fromResp(h))) },
      ...RULES.map(([key, label]) => ({ key, label, isJev: false, cells: horizons.map(h => cell(h, signal(key), fromState(h))) })),
      // The order-book model takes microseconds too, so it is scored like the simple rules. It has
      // no 2 s model, so that cell stays empty.
      { key: 'ob', label: 'Order-book model', isJev: false, cells: horizons.map(h => cell(h, signal(`ob_${h}s`), fromState(h))) },
    ],
    beyond: horizons.map(h => {
      const jev = signal(`jevc_${h}s`);
      const move = fromState(h);
      const n = jev.filter((s, i) => Number.isFinite(s) && Number.isFinite(move[i]!)).length;
      return { horizonS: h, ic: orNull(partialSpearman(jev, move, RULES.map(([key]) => signal(key)))), n };
    }),
  };
}
