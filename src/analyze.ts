// Score decision logs from `live` or `backtest`.
//   1. Latency budget: where the time goes between an exchange event and a usable decision.
//   2. Signal quality per horizon: Jev vs zero-latency baselines, net of trading cost.
//   3. Jev's lean: how one-sided its answers are, and what reading them against its usual lean is worth.
//   4. Latency decay: how much of the move happens while waiting for the model.
//   5. Calibration of Jev's direction probabilities.
//
//   npm run analyze -- data/decisions/<file>.jsonl [more files...]

import { readFileSync } from 'node:fs';
import { config } from './config.ts';
import type { DecisionRecord } from './engine.ts';
import { bps as bp, independentCount, mean, num, partialSpearman, spearman, summarize, tStat } from './lib/stats.ts';
import { spreadBps } from './model/costs.ts';
import { DIRECTIONS, type DirectionId } from './model/jev.ts';
import { fillLeans } from './model/lean.ts';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: npm run analyze -- <decisions.jsonl> [...]');
const recs: DecisionRecord[] = files
  .flatMap(f =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as DecisionRecord),
  )
  .sort((a, b) => a.tState - b.tState); // several files may overlap or arrive out of order
if (recs.length === 0) throw new Error('no decisions in input');
// Files from before leans were read against Jev's usual one get the same reading a live run would have made.
fillLeans([...recs].sort((a, b) => a.tResp - b.tResp));

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pad = (s: string | number, n: number) => String(s).padStart(n);

const routes = new Set(recs.map(r => r.provider));
// Which build of Jev answered. Only the direct API says, so a gateway run shows none.
const builds = [...new Set(recs.map(r => r.modelVersion).filter(Boolean))];
console.log(
  `${recs.length} decisions from ${files.length} file(s); modes: ${[...new Set(recs.map(r => `${r.mode}/${r.provider}`))].join(', ')}` +
    (builds.length ? `; Jev ${builds.join(', ')}` : ''),
);
if (builds.length > 1) console.log('  more than one build of Jev answered in this run, so its parts are not strictly comparable');
const gaps = recs.slice(1).map((r, i) => r.tState - recs[i]!.tState);
// Time actually covered: pauses longer than five minutes (rate limits, separate runs) are not counted.
const coveredS = gaps.filter(g => g < 5 * 60_000).reduce((a, b) => a + b, 0) / 1000;
// What a round trip costs: the fee on both fills, and the spread (the mean over decisions that saved their quotes).
const spreads = recs.filter(r => r.quote).map(spreadBps);
const meanSpread = spreads.length > 0 ? mean(spreads) : 0;
const roundTrip = 2 * config.feeBpsPerSide + meanSpread;
console.log(
  `${fmt(coveredS / 60, 1)} min of decisions, median spacing ${fmt(summarize(gaps).p50 / 1000, 2)}s; a round trip costs ${fmt(roundTrip, 2)}bp: ` +
    `${config.feeBpsPerSide}bp a fill, twice (FEE_BPS_PER_SIDE), and ${spreads.length > 0 ? `a mean spread of ${fmt(meanSpread, 3)}bp` : 'no spread (these records saved no quotes)'}`,
);
const costs = recs.map(r => num(r.costUsd)).filter(Number.isFinite); // older records have none
const cost = costs.reduce((a, b) => a + b, 0);
const tokens = summarize(recs.map(r => num(r.inputTokens)).filter(Number.isFinite));
if (tokens.n) console.log(`input tokens per decision p50 ${tokens.p50.toFixed(0)}` + (costs.length ? `; model cost at list price $${cost.toFixed(4)} in total, $${fmt((cost / costs.length) * 1000, 4)} per 1,000 decisions` : ''));
console.log('');

// ---- 1. latency budget --------------------------------------------------------
console.log('LATENCY BUDGET (ms)                 p50      p90      p99');
const row = (name: string, xs: number[], d = 1) => {
  const s = summarize(xs.filter(Number.isFinite));
  if (s.n) console.log(`  ${name.padEnd(32)} ${pad(fmt(s.p50, d), 7)}  ${pad(fmt(s.p90, d), 7)}  ${pad(fmt(s.p99, d), 7)}`);
};
row('age of newest data at decision', recs.map(r => r.exchLagMs));
row('features + encoding', recs.map(r => r.buildMs), 3);
row(`model round trip${recs[0]!.mode === 'backtest' ? ' (simulated)' : ''}`, recs.map(r => r.modelMs));
// Jev's own time is reported by whichever route was used; the rest of the round trip is what
// getting there and back cost, which is where the gateway route spends its extra hop.
row('  of which: Jev itself (reported)', recs.map(r => num(r.providerMs)));
row(`  of which: ${routes.has('gateway') ? 'network + gateway' : 'network'}`, recs.map(r => r.modelMs - num(r.providerMs)));
row('exchange event -> decision', recs.map(r => r.exchLagMs + r.buildMs + r.modelMs));
console.log('');

// ---- 2. signal quality ----------------------------------------------------------
type Score = { n: number; nInd: number; ic: number; t: number; hit: number; spread: number; edge: number };

function score(signal: number[], ret: number[], horizonS: number): Score {
  const rows = signal.map((s, i) => [s, ret[i]!, recs[i]!.tState] as const).filter(([s, r]) => Number.isFinite(s) && Number.isFinite(r));
  const n = rows.length;
  // Decisions closer together than the horizon share their forward window, and features
  // look back ~5 s, so count separate stretches of time rather than decisions.
  const nInd = independentCount(rows.map(r => r[2]), Math.max(horizonS, 5) * 1000);
  if (n < 10) return { n, nInd, ic: NaN, t: NaN, hit: NaN, spread: NaN, edge: NaN };
  const ic = spearman(rows.map(p => p[0]), rows.map(p => p[1]));
  const directional = rows.filter(([s, r]) => s !== 0 && r !== 0);
  const hit = directional.filter(([s, r]) => Math.sign(s) === Math.sign(r)).length / directional.length;
  const sorted = [...rows].sort((a, b) => a[0] - b[0]);
  const k = Math.max(1, Math.floor(n / 5));
  const meanRet = (xs: typeof sorted) => xs.reduce((a, p) => a + p[1], 0) / xs.length;
  const spread = meanRet(sorted.slice(n - k)) - meanRet(sorted.slice(0, k));
  // Long the top quintile, short the bottom, hold for the horizon: average return per trade, after costs.
  const edge = spread / 2 - roundTrip;
  return { n, nInd, ic, t: tStat(ic, nInd), hit, spread, edge };
}

const jevFor = Object.fromEntries(Object.entries(DIRECTIONS).map(([id, d]) => [d.seconds, `jev_${id.slice(4)}`]));
const baselines = ['obi1', 'obi5', 'flow5', 'mom5'];
/** jev_10s -> jevc_10s: the same answer with Jev's usual lean taken out (src/model/lean.ts). */
const corrected = (name: string) => name.replace('jev_', 'jevc_');
const jevNames = Object.keys(recs[0]!.signals).filter(k => k.startsWith('jev_'));

console.log('SIGNAL QUALITY    Spearman IC with forward mid return');
console.log('  n = decisions; ind = decisions far enough apart (max(horizon, 5s)) to be separate evidence; t is computed from ind');
console.log('  jev_* scored from when the answer arrived (tradable); @state = from the snapshot (information only)');
console.log('  jevc_* = the same answer with Jev\'s usual lean taken out: the ranking barely changes, which way it points does (hit%)');
console.log('  baselines are computed in microseconds, so they are scored from the snapshot');
console.log('  ob_* = the order-book model (src/model/ridge.ts), its expected move in bp; net edge charges every trade a full round trip');
console.log('  horizon  signal            n    ind      IC      t   hit%  Q5-Q1bp  net edge bp');
for (const h of config.horizons) {
  const retResp = recs.map(r => bp(r.fwdResp[h], r.midResp));
  const retState = recs.map(r => bp(r.fwdState[h], r.midState));
  const oracle = mean(retState.map(Math.abs));
  console.log(`  ${pad(h + 's', 7)}  perfect foresight: mean |move| ${fmt(oracle, 2)}bp vs ${fmt(roundTrip, 2)}bp a round trip`);
  const lines: [string, Score][] = [];
  for (const name of jevNames) lines.push([name, score(recs.map(r => num(r.signals[name])), retResp, h)]);
  if (jevFor[h]) lines.push([corrected(jevFor[h]!), score(recs.map(r => num(r.signals[corrected(jevFor[h]!)])), retResp, h)]);
  if (jevFor[h]) lines.push([`${jevFor[h]} @state`, score(recs.map(r => num(r.signals[jevFor[h]!])), retState, h)]);
  for (const name of baselines) lines.push([name, score(recs.map(r => num(r.signals[name])), retState, h)]);
  // The order-book model: from the snapshot like the other rules, and from when Jev's answer
  // arrived, which is when the dashboard's profit and loss trades it.
  if (recs.some(r => Number.isFinite(num(r.signals[`ob_${h}s`])))) {
    lines.push([`ob_${h}s`, score(recs.map(r => num(r.signals[`ob_${h}s`])), retState, h)]);
    lines.push([`ob_${h}s @resp`, score(recs.map(r => num(r.signals[`ob_${h}s`])), retResp, h)]);
  }
  for (const [name, s] of lines) {
    console.log(
      `  ${pad(h + 's', 7)}  ${name.padEnd(15)} ${pad(s.n, 5)}  ${pad(s.nInd, 5)}  ${pad(fmt(s.ic, 3), 6)}  ${pad(fmt(s.t, 1), 5)}  ${pad(fmt(s.hit * 100, 0), 4)}  ${pad(fmt(s.spread, 2), 7)}  ${pad(fmt(s.edge, 2), 11)}`,
    );
  }
  // Does Jev know anything the simple rules don't? Same snapshot, same forward window, with the
  // part the four rules explain removed from both Jev's signal and the move.
  if (jevFor[h]) {
    const controls = baselines.map(name => recs.map(r => num(r.signals[name])));
    const beyond = partialSpearman(recs.map(r => num(r.signals[jevFor[h]!])), retState, controls);
    const nInd = lines.find(([name]) => name === `${jevFor[h]} @state`)![1].nInd;
    console.log(`  ${pad(h + 's', 7)}  ${`${jevFor[h]} beyond the rules`.padEnd(27)} ${pad(fmt(beyond, 3), 13)}  ${pad(fmt(tStat(beyond, nInd - baselines.length), 1), 5)}   (what is left once the four rules are accounted for)`);
  }
}
console.log('');

// ---- 3. Jev's lean ----------------------------------------------------------------
// Everything here is measured from when the answer arrived, on decisions where the price moved.
console.log("JEV'S LEAN    how one-sided the answers are, and what reading them against Jev's usual lean is worth");
const share = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : NaN);
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '-');
for (const [id, d] of Object.entries(DIRECTIONS)) {
  const name = `jev_${id.slice(4)}`;
  const rows = recs
    .map(r => ({ raw: num(r.signals[name]), lean: num(r.signals[corrected(name)]), usual: num(r.lean?.[id as DirectionId]?.usual), book: num(r.signals.obi1), move: bp(r.fwdResp[d.seconds], r.midResp) }))
    .filter(x => Number.isFinite(x.raw) && Number.isFinite(x.move));
  if (rows.length < 50) continue;
  const moved = rows.filter(x => x.move !== 0);
  const right = (xs: typeof rows, key: 'raw' | 'lean' | 'book') => share(xs.filter(x => x[key] !== 0 && Number.isFinite(x[key])).map(x => Math.sign(x[key]) === Math.sign(x.move)));
  console.log(`  ${id.padEnd(8)} the price rose in ${pct(share(moved.map(x => x.move > 0)))} of the moves; Jev leaned up in ${pct(share(rows.filter(x => x.raw !== 0).map(x => x.raw > 0)))} of its answers (usual lean ${fmt(summarize(rows.map(x => x.usual).filter(Number.isFinite)).p50)})`);
  const known = moved.filter(x => Number.isFinite(x.lean));
  if (known.length < 50) {
    console.log(`  ${''.padEnd(8)} too few answers close together to know the usual lean (it needs 60 within 15 minutes)`);
    continue;
  }
  console.log(`  ${''.padEnd(8)} right way: ${pct(right(known, 'raw'))} as answered -> ${pct(right(known, 'lean'))} with the usual lean taken out   (best level of the book alone: ${pct(right(known, 'book'))})`);
  // Does a stronger lean mean more? Fifths of the corrected lean's strength, weakest first.
  const byStrength = [...known].filter(x => x.lean !== 0).sort((a, b) => Math.abs(a.lean) - Math.abs(b.lean));
  const fifths = Array.from({ length: 5 }, (_, i) => byStrength.slice(Math.floor((i * byStrength.length) / 5), Math.floor(((i + 1) * byStrength.length) / 5)));
  console.log(`  ${''.padEnd(8)} right way by strength of lean, weakest fifth to strongest: ${fifths.map(xs => pct(right(xs, 'lean'))).join(' -> ')}`);
  const both = known.filter(x => x.lean !== 0 && x.book !== 0 && Number.isFinite(x.book));
  const agree = both.filter(x => Math.sign(x.lean) === Math.sign(x.book));
  const disagree = both.filter(x => Math.sign(x.lean) !== Math.sign(x.book));
  console.log(`  ${''.padEnd(8)} Jev and the book agree ${pct(agree.length / both.length)} of the time and are then right ${pct(right(agree, 'lean'))}; when they disagree Jev is right ${pct(right(disagree, 'lean'))}`);
}
console.log('');

// ---- 4. latency decay -----------------------------------------------------------
console.log('LATENCY DECAY    what moved while the model was thinking');
const during = recs.map(r => bp(r.midResp, r.midState));
console.log(`  |mid move| during model call: mean ${fmt(mean(during.map(Math.abs)), 3)}bp`);
for (const name of jevNames) {
  const ic = spearman(recs.map(r => num(r.signals[name])), during);
  console.log(`  ${name.padEnd(8)} IC with the move that already happened before the answer arrived: ${fmt(ic, 3)}`);
}
console.log('');

// ---- 5. calibration -------------------------------------------------------------
console.log('CALIBRATION    predicted P(up)/P(down) vs realized frequency, from the snapshot');
console.log('  each decision is judged against the "flat" threshold it was asked with; median threshold shown per question');
for (const [id, d] of Object.entries(DIRECTIONS)) {
  const bins = Array.from({ length: 5 }, () => ({ n: 0, p: 0, hits: 0 }));
  const thresholds: number[] = [];
  let answers = { up: 0, down: 0, flat: 0, n: 0 };
  for (const r of recs) {
    const p = r.probabilities?.[id as DirectionId];
    const ret = bp(r.fwdState[d.seconds], r.midState);
    if (!p || !Number.isFinite(ret)) continue;
    const flat = num(r.flatBps?.[id as DirectionId]) || d.flatBps; // files from before thresholds were recorded used the fixed ones
    thresholds.push(flat);
    answers = { up: answers.up + (p.up ?? 0), down: answers.down + (p.down ?? 0), flat: answers.flat + (p.flat ?? 0), n: answers.n + 1 };
    for (const [outcome, happened] of [
      ['up', ret > flat],
      ['down', ret < -flat],
    ] as const) {
      const prob = p[outcome] ?? 0;
      const b = bins[Math.min(4, Math.floor(prob * 5))]!;
      b.n++;
      b.p += prob;
      b.hits += happened ? 1 : 0;
    }
  }
  const cells = bins.map((b, i) => `${(i / 5).toFixed(1)}-${((i + 1) / 5).toFixed(1)}: ${b.n ? `${fmt(b.p / b.n)}→${fmt(b.hits / b.n)} (n${b.n})` : '-'}`);
  console.log(`  ${id.padEnd(8)} flat ±${fmt(summarize(thresholds).p50, 1)}bp  ${cells.join('  ')}`);
  if (answers.n) console.log(`  ${''.padEnd(8)} average answer: up ${fmt(answers.up / answers.n)} / flat ${fmt(answers.flat / answers.n)} / down ${fmt(answers.down / answers.n)}`);
}
