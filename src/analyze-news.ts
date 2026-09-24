// Event study over news decisions from `npm run news`.
//   1. Acquisition: publish -> received -> answer, per source, and what it cost.
//   2. Which news matters: realized |move| after items Jev rates relevant vs not, and rank
//      correlation of its magnitude score with the realized |move|. This is a volatility
//      question and is usually easier to answer than direction.
//   3. Direction: relevance-weighted signal vs signed move, among relevant items, and which way
//      of combining Jev's answers ranks the moves best.
//   4. Timing: how much moved before we saw the item and while Jev was answering.
//   5. The items, most relevant first.
//
//   npm run analyze:news -- data/decisions/news-*.jsonl
//   RELEVANT_P=0.6 npm run analyze:news -- <files>

import { readFileSync } from 'node:fs';
import { config, envNum } from './config.ts';
import { bps, independentCount, mean, num, spearman, summarize, tStat } from './lib/stats.ts';
import type { NewsRecord } from './news/engine.ts';
import { entryOk as entryOkAt, tradableMove } from './news/moves.ts';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: npm run analyze:news -- <news decisions.jsonl> [...]');
const recs: NewsRecord[] = files
  .flatMap(f =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as NewsRecord),
  )
  .sort((a, b) => a.tResp - b.tResp);
if (recs.length === 0) throw new Error('no news decisions in input');
// Records written before multi-asset support covered Bitcoin only.
for (const r of recs) {
  r.symbol ??= 'BTC-USD';
  r.assetClass ??= 'crypto';
  r.tracked ??= true;
}

const threshold = envNum('RELEVANT_P', 0.5);
/** Stock quotes wider than this are not prices (after-hours IEX quotes can be 10% wide). */
const maxSpread = config.news.maxSpreadBps;
const horizons = config.news.horizons;
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pad = (s: string | number, n: number) => String(s).padStart(n);
const label = (h: number) => (h < 60 ? `${h}s` : `${h / 60}m`);

// A stock move is only real if there was a usable quote at both ends (src/news/moves.ts).
const entryOk = (r: NewsRecord) => entryOkAt(r, maxSpread);
const move = (r: NewsRecord, h: number) => tradableMove(r, h, maxSpread);
/** A round trip pays the fee on both fills and crosses the spread, taken as it was when the answer arrived. */
const roundTrip = (r: NewsRecord) => 2 * config.feeBpsPerSide + (Number.isFinite(num(r.spreadBps)) ? num(r.spreadBps) : 0);

const bySource = new Map<string, number>();
for (const r of recs) bySource.set(r.item.source, (bySource.get(r.item.source) ?? 0) + 1);
const classes = [...new Set(recs.map(r => r.assetClass))];
const count = (xs: NewsRecord[], key: (r: NewsRecord) => string) => {
  const m = new Map<string, number>();
  for (const r of xs) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m].map(([k, n]) => `${k} ${n}`).join(', ');
};
// One model call per item, shared by its instruments. Records from one call share its start time
// (typed test headlines reuse ids like "manual:1" from run to run, so the id alone is not enough).
const calls = new Map<string, NewsRecord>();
for (const r of recs) calls.set(`${r.item.id}|${r.tState}`, r);
const costs = [...calls.values()].map(r => num(r.costUsd)).filter(Number.isFinite); // older records have none
const cost = costs.reduce((a, b) => a + b, 0);

const builds = [...new Set(recs.map(r => r.modelVersion).filter(Boolean))];
console.log(
  `${recs.length} news decisions (one per item and instrument) from ${calls.size} model calls in ${files.length} file(s)` +
    (builds.length ? `; Jev ${builds.join(', ')}` : ''),
);
console.log(`sources: ${[...bySource].map(([s, n]) => `${s} ${n}`).join(', ')}`);
console.log(
  `instruments: ${count(recs, r => r.assetClass)}; stock sessions: ${count(recs.filter(r => r.assetClass === 'equity'), r => r.session) || '-'}; ` +
    `left out of price moves: ${recs.filter(r => !r.tracked).length} without live prices, ${recs.filter(r => !entryOk(r)).length} with the market closed or a quote wider than ${maxSpread}bp`,
);
if (costs.length) console.log(`model cost at list price: $${cost.toFixed(4)} for the ${costs.length} calls that recorded it, $${fmt((cost / costs.length) * 1000, 3)} per 1,000 calls`);
console.log('small samples: treat everything below as anecdotal until there are hundreds of relevant items\n');

// ---- 1. acquisition ------------------------------------------------------------
console.log('ACQUISITION                          n      p50      p90');
const line = (name: string, xs: number[], unit: string, d = 1) => {
  const s = summarize(xs.filter(Number.isFinite));
  if (s.n) console.log(`  ${name.padEnd(32)} ${pad(s.n, 4)}  ${pad(fmt(s.p50, d) + unit, 7)}  ${pad(fmt(s.p90, d) + unit, 7)}`);
};
const perCall = [...calls.values()];
for (const source of bySource.keys()) {
  const rs = perCall.filter(r => r.item.source === source && r.item.publishedTs && source !== 'manual');
  if (rs.length) line(`${source}: publish -> received`, rs.map(r => (r.item.recvTs - r.item.publishedTs!) / 1000), 's', 0);
}
line('queue wait (rate limits, retries)', perCall.map(r => r.queueMs / 1000), 's');
line('getting prices ready', perCall.map(r => r.prepareMs), 'ms', 0);
line('model round trip', perCall.map(r => r.modelMs), 'ms', 0);
line('  of which: Jev itself (reported)', perCall.map(r => num(r.providerMs)), 'ms', 0);
line(`  of which: ${new Set(recs.map(r => r.provider)).has('gateway') ? 'network + gateway' : 'network'}`, perCall.map(r => r.modelMs - num(r.providerMs)), 'ms', 0);
console.log('  publish times are what the feed claims (often minute precision), so treat them as bounds\n');

/** Separate events: the same instrument's records count once per horizon-length stretch of time. */
function independentEvents(rs: NewsRecord[], h: number) {
  const bySymbol = new Map<string, number[]>();
  for (const r of rs) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r.tResp]);
  return [...bySymbol.values()].reduce((a, times) => a + independentCount(times, h * 1000), 0);
}

/** Ways of turning Jev's answers into one number that says "up" or "down" and how strongly. */
const RECIPES: [string, (r: NewsRecord) => number][] = [
  ['direction only', r => (num(r.direction?.bullish) || 0) - (num(r.direction?.bearish) || 0)],
  ['x relevance (the recorded signal)', r => r.signal],
  ['x relevance x novelty', r => r.signal * r.novel],
  ['x relevance x novelty x size', r => (r.signal * r.novel * r.magnitude) / 3],
  ['x relevance x confidence', r => r.signal * num(r.confidence?.direction)],
];

function report(name: string, recs: NewsRecord[]) {
  if (!recs.some(r => horizons.some(h => Number.isFinite(move(r, h))))) {
    console.log(`[${name}] ${recs.length} records, none with a usable price at both ends of any horizon yet\n`);
    return;
  }
  const relevant = recs.filter(r => r.relevant >= threshold);
  const other = recs.filter(r => r.relevant < threshold);
  // ---- 2. which news matters ---------------------------------------------------------
  console.log(`[${name}] WHICH NEWS MATTERS    mean |move| after the answer arrived (bp); IC = rank correlation with |move|`);
  console.log('  horizon   relevant      ...and novel    not relevant   size IC   relevance IC   novelty IC');
  for (const h of horizons) {
    const abs = (xs: NewsRecord[]) => xs.map(r => Math.abs(move(r, h)));
    const absAll = abs(recs);
    const n = (xs: number[]) => xs.filter(Number.isFinite).length;
    const cell = (xs: number[]) => `${pad(fmt(mean(xs), 2), 6)} (n${pad(n(xs), 3)})`;
    const ic = (key: (r: NewsRecord) => number) => pad(fmt(spearman(recs.map(key), absAll), 3), 8);
    console.log(
      `  ${pad(label(h), 7)}   ${cell(abs(relevant))}  ${cell(abs(relevant.filter(r => r.novel >= 0.5)))}  ${cell(abs(other))}  ${ic(r => r.magnitude)}  ${ic(r => r.relevant)}      ${ic(r => r.novel)}`,
    );
  }
  console.log('');

  // ---- 3. direction ----------------------------------------------------------------
  console.log(`[${name}] DIRECTION (relevant items)    signal = P(relevant) x (P(bullish) - P(bearish)) vs signed move`);
  console.log(`  horizon     n   events      IC      t   hit%   net edge bp (after ${config.feeBpsPerSide}bp a fill, twice, and the spread)`);
  for (const h of horizons) {
    const rows = relevant.map(r => [r, r.signal, move(r, h)] as const).filter(([, s, m]) => Number.isFinite(m) && s !== 0);
    const ic = spearman(rows.map(p => p[1]), rows.map(p => p[2]));
    const events = independentEvents(rows.map(p => p[0]), h);
    const decided = rows.filter(([, , m]) => m !== 0);
    const hits = decided.filter(([, s, m]) => Math.sign(s) === Math.sign(m));
    const edge = mean(rows.map(([r, s, m]) => Math.sign(s) * m - roundTrip(r)));
    console.log(
      `  ${pad(label(h), 7)}  ${pad(rows.length, 4)}  ${pad(events, 7)}  ${pad(fmt(ic, 3), 6)}  ${pad(fmt(tStat(ic, events), 1), 5)}  ${pad(fmt((hits.length / decided.length) * 100, 0), 5)}  ${pad(fmt(edge, 2), 12)}`,
    );
  }
  console.log('  events = records far enough apart (one horizon, per instrument) to be separate evidence; t is computed from it');
  const at = [300, 1800].filter(h => horizons.includes(h));
  console.log(`  which way of combining the answers ranks moves best? IC over all priced records, at ${at.map(label).join(' and ')}:`);
  for (const [recipe, signal] of RECIPES) {
    const ics = at.map(h => {
      const rows = recs.map(r => [signal(r), move(r, h)] as const).filter(([s, m]) => Number.isFinite(s) && Number.isFinite(m));
      return `${pad(fmt(spearman(rows.map(p => p[0]), rows.map(p => p[1])), 3), 7)} (n${pad(rows.length, 3)})`;
    });
    console.log(`    ${recipe.padEnd(34)} ${ics.join('  ')}`);
  }
  console.log('');

  // ---- 4. timing -----------------------------------------------------------------------
  console.log(`[${name}] TIMING (relevant items)    mean |move| before we could act (bp)`);
  const before = relevant.filter(entryOk).map(r => Math.abs(bps(r.midRecv, r.midPublished)));
  const during = relevant.filter(entryOk).map(r => Math.abs(bps(r.midResp, r.midRecv)));
  console.log(`  publish -> received: ${fmt(mean(before), 2)} (n${before.filter(Number.isFinite).length})   received -> answer: ${fmt(mean(during), 2)} (n${during.filter(Number.isFinite).length})\n`);
}

for (const c of classes) report(c, recs.filter(r => r.assetClass === c));

// ---- 5. items ----------------------------------------------------------------------
const shown = [60, 300, 1800].filter(h => horizons.includes(h));
console.log(`ITEMS (most relevant first)   symbol   rel  bull bear  mag  novel | move from answer: ${shown.map(label).join(' / ')} (bp)`);
for (const r of [...recs].sort((a, b) => b.relevant - a.relevant).slice(0, envNum('SHOW', 25, { min: 0 }))) {
  const t = new Date(r.item.recvTs).toISOString().slice(5, 19).replace('T', ' ');
  const moves = shown.map(h => pad(fmt(move(r, h), 1), 6)).join(' ');
  console.log(
    `  ${t} ${r.item.source.padEnd(15).slice(0, 15)} ${r.symbol.padEnd(8)} ${fmt(r.relevant, 2)} ${fmt(r.direction.bullish ?? 0, 2)} ${fmt(r.direction.bearish ?? 0, 2)} ${fmt(r.magnitude, 2)} ${fmt(r.novel, 2)} |${moves} | ${r.item.headline.slice(0, 70)}`,
  );
}
