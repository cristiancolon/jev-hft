// Turns the dashboard's state into what is on the page. Each function owns one card, touches
// the page only where something changed, and can be called as often as you like.

import { actedLean, type DashboardState, type Decision, type NewsEntry, type OrderBookReach, type Pnl, type Scoreboard } from '../collector.ts';
import * as f from './format.ts';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}
function setHtml(el: HTMLElement, html: string) {
  if (el.innerHTML !== html) el.innerHTML = html;
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---- top bar -----------------------------------------------------------------------------

export type Liveness = 'live' | 'stale' | 'off';
/** A pulse arrives every second: a few missed is "stale", many is "off". */
export const liveness = (msSinceHeard: number | null): Liveness => (msSinceHeard === null || msSinceHeard > 15_000 ? 'off' : msSinceHeard > 3500 ? 'stale' : 'live');

export function renderPill(program: 'live' | 'news', state: Liveness, provider: string | undefined, run: number | undefined, msSinceHeard: number | null) {
  $(`pill-${program}`).dataset.state = state;
  const sub = $(`pill-${program}-sub`);
  if (state === 'off') setText(sub, msSinceHeard === null ? 'not running' : `stopped · last heard ${f.ago(msSinceHeard)}`);
  else setText(sub, `${state === 'stale' ? 'quiet · ' : ''}${provider ?? ''}${run ? ` · up ${f.duration(Date.now() - run)}` : ''}`);
}

export function providerBadge(el: HTMLElement, provider: string | undefined) {
  el.hidden = !provider;
  if (!provider) return;
  el.classList.toggle('mock', provider === 'mock');
  setText(el, provider === 'mock' ? 'practice model · random answers' : provider === 'typesafe' ? 'straight to TypeSafe' : 'through the gateway');
}

// ---- market data: price and numbers ------------------------------------------------------

let lastMid: number | null = null;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

export function renderHero(state: DashboardState, windowMs: number) {
  const pulse = state.live.pulse;
  if (!pulse) return;
  const { mid, bid, ask } = pulse.market;
  const priceEl = $('price');
  setText(priceEl, f.price(mid));
  if (mid !== null && lastMid !== null && mid !== lastMid) {
    priceEl.classList.remove('up', 'down');
    void priceEl.offsetWidth; // restart the fade
    priceEl.classList.add(mid > lastMid ? 'up' : 'down');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => priceEl.classList.remove('up', 'down'), 140);
  }
  lastMid = mid;

  const ticks = state.live.ticks;
  const newest = ticks[ticks.length - 1];
  const from = newest && ticks.find(k => k.t >= newest.t - windowMs);
  const change = $('price-change');
  if (newest && from && from !== newest) {
    const moved = ((newest.mid - from.mid) / from.mid) * 1e4;
    setText(change, `${f.bp(moved)} over the last ${Math.max(1, Math.round((newest.t - from.t) / 60_000))} min`);
    change.className = `hero-change ${moved > 0 ? 'up' : moved < 0 ? 'down' : ''}`;
  } else setText(change, pulse.market.ready ? ' ' : 'waiting for the order book…');

  setText($('product'), pulse.meta.product);
  providerBadge($('live-badge'), pulse.meta.provider);
  $('rec-badge').hidden = !pulse.meta.recording;
  setText($('st-spread'), mid !== null && bid !== null && ask !== null ? `${(((ask - bid) / mid) * 1e4).toFixed(3)} bp` : '—');
  setText($('st-lag'), f.ms(pulse.feed.lagMs));
  setText($('st-eps'), f.int(pulse.feed.eventsPerS));
  setText($('st-cost'), pulse.eventCostUs ? `${Math.round(pulse.eventCostUs.p50)} µs` : '—');
  setText($('st-decisions'), f.int(pulse.stats.decisions));
  setText($('st-written'), f.int(pulse.stats.written));
}

// ---- market data: the latest answer ----------------------------------------------------------

const HORIZONS = [2, 10, 60];

export function buildHorizons() {
  $('horizons').innerHTML = HORIZONS.map(
    h => `<div class="hz" data-h="${h}">
      <div class="hz-when"><b>in ${h} s</b><span class="flat">&nbsp;</span></div>
      <div class="prob"><i class="p-down"></i><i class="p-flat"></i><i class="p-up"></i></div>
      <div class="hz-read"><b>—</b><span>&nbsp;</span></div>
    </div>`,
  ).join('');
}

/** The three bars of one answer: how likely down, flat, up. Shared by the card and the chart's tooltip. */
function probHtml(p: Record<string, number> | undefined, mini = false) {
  const part = (cls: string, v: number) => `<i class="${cls}" style="flex-basis:${(v * 100).toFixed(1)}%">${!mini && v >= 0.15 ? f.pct(v) : ''}</i>`;
  return `<div class="prob${mini ? ' mini' : ''}">${part('p-down', p?.down ?? 0)}${part('p-flat', p?.flat ?? 0)}${part('p-up', p?.up ?? 0)}</div>`;
}

/**
 * What the part of the round trip that isn't Jev consists of. Going straight to TypeSafe it is
 * only the network; through the gateway it is the network and the gateway's own hop.
 */
const routeLabel = (provider: string | undefined) => (provider === 'gateway' ? 'network + gateway' : 'network');

export function renderLatestAnswer(state: DashboardState, msSince: (t: number) => number) {
  const d = state.live.decisions.findLast(x => x.answer);
  if (!d?.answer) return;
  const a = d.answer;
  setText($('decision-age'), `#${d.id} · ${f.ago(msSince(a.tResp))}`);

  for (const row of $('horizons').children as HTMLCollectionOf<HTMLElement>) {
    const h = Number(row.dataset.h);
    const id = `dir_${h}s`;
    const p = a.probabilities[id];
    const segs = row.querySelectorAll<HTMLElement>('.prob i');
    (['down', 'flat', 'up'] as const).forEach((k, i) => {
      const v = p?.[k] ?? 0;
      segs[i]!.style.flexBasis = `${(v * 100).toFixed(1)}%`;
      setText(segs[i]!, v >= 0.15 ? f.pct(v) : '');
    });
    setText(row.querySelector<HTMLElement>('.flat')!, `flat: ±${d.flatBps[id as keyof typeof d.flatBps]} bp`);
    // The call is Jev's answer read against what it has usually been saying, not the answer at
    // face value: Jev leans "down" most of the time, so a little less down than usual is a lean up.
    const answered = (p?.up ?? 0) - (p?.down ?? 0);
    const lean = actedLean(a.signals, h);
    const usual = a.lean?.[id]?.usual;
    const read = row.querySelector<HTMLElement>('.hz-read')!;
    read.className = `hz-read ${lean === null ? '' : lean > 0.05 ? 'up' : lean < -0.05 ? 'down' : ''}`;
    setText(read.querySelector('b')!, lean === null ? 'no call yet' : `${lean > 0.05 ? 'up' : lean < -0.05 ? 'down' : 'no lean'} ${f.signed(lean)}`);
    setText(
      read.querySelector('span')!,
      typeof usual === 'number' ? `answered ${f.signed(answered)}, usually ${f.signed(usual)}` : a.lean === undefined ? ' ' : `answered ${f.signed(answered)}; learning its usual lean`,
    );
  }

  const model = a.providerMs;
  const route = model === null ? null : Math.max(0, a.modelMs - model);
  setText($('split-total'), f.ms(a.modelMs));
  $('split-model').style.flexBasis = model === null ? '0%' : `${(model / a.modelMs) * 100}%`;
  $('split-route').style.flexBasis = model === null ? '100%' : `${((route ?? 0) / a.modelMs) * 100}%`;
  setText($('split-model-ms'), f.ms(model));
  setText($('split-route-label'), routeLabel(state.live.pulse?.meta.provider));
  setText($('split-route-ms'), f.ms(route));
  setText($('split-tokens'), f.int(a.inputTokens));
  setText($('split-cost'), f.usd(a.costUsd, 6));

  setHtml($('state-text'), paintState(d.state));
}

/** Light colouring of the text Jev read: labels dimmed, rises green, falls red, "how unusual" in blue. */
function paintState(text: string) {
  return f
    .esc(text)
    .replace(/^([a-z][^:\n]{2,60}?:)/gm, '<span class="k">$1</span>') // labels start in lower case; the first line (the product) does not
    .replace(/\(z ([+−-][\d.]+)\)|([+-])(\d[\d.,]*)/g, (whole, z: string | undefined, sign: string | undefined, digits: string | undefined) => {
      if (z !== undefined) return `<span class="z">(z ${z})</span>`;
      if (Number(digits!.replace(/,/g, '')) === 0) return whole;
      return `<span class="${sign === '+' ? 'pos' : 'neg'}">${whole}</span>`;
    });
}

// ---- market data: gauges ---------------------------------------------------------------------

const GAUGES: { key: string; label: string; unit: string; digits: number; bounded: boolean }[] = [
  { key: 'imb1', label: 'Best price level', unit: '', digits: 2, bounded: true },
  { key: 'imb5', label: 'Top 5 levels', unit: '', digits: 2, bounded: true },
  { key: 'imb20', label: 'Top 20 levels', unit: '', digits: 2, bounded: true },
  { key: 'flow5', label: 'Buying − selling, 5 s', unit: '', digits: 3, bounded: false },
  { key: 'ret5', label: 'Price change, 5 s', unit: ' bp', digits: 2, bounded: false },
];

export function buildGauges() {
  $('gauges').innerHTML =
    GAUGES.map(g => `<div class="gauge" data-k="${g.key}"><span>${g.label}</span><div class="track"><i></i></div><b>—</b></div>`).join('') +
    `<p class="gauge-note">Bars right of centre mean more buyers than sellers; left, more sellers. <span id="gauge-extra"></span></p>`;
}

export function renderGauges(state: DashboardState) {
  const recent = state.live.decisions.slice(-180);
  const latest = recent[recent.length - 1];
  if (!latest) return;
  const feats = latest.features as unknown as Record<string, number | null>;
  for (const g of GAUGES) {
    const row = $('gauges').querySelector<HTMLElement>(`[data-k="${g.key}"]`)!;
    const v = feats[g.key];
    const bar = row.querySelector<HTMLElement>('i')!;
    if (typeof v !== 'number') {
      bar.style.width = '0%';
      setText(row.querySelector('b')!, '—');
      continue;
    }
    // Unbounded numbers are drawn relative to the largest seen in the last few minutes.
    const scale = g.bounded ? 1 : Math.max(1e-9, ...recent.map(d => Math.abs((d.features as unknown as Record<string, number | null>)[g.key] ?? 0)));
    const share = clamp(v / scale, -1, 1);
    bar.style.left = share >= 0 ? '50%' : `${50 + share * 50}%`;
    bar.style.width = `${Math.abs(share) * 50}%`;
    bar.style.background = share >= 0 ? 'var(--up)' : 'var(--down)';
    setText(row.querySelector('b')!, `${f.signed(v, g.digits)}${g.unit}`);
  }
  setText($('gauge-extra'), `${latest.features.trades5} trades in the last 5 s; typical 1-second move ${f.fixed(latest.features.vol60, 2)} bp.`);
}

// ---- market data: response time ----------------------------------------------------------------

export function latencySeries(state: DashboardState, count = 150) {
  const answered = state.live.decisions.filter(d => d.answer).slice(-count);
  return { total: answered.map(d => d.answer!.modelMs), model: answered.map(d => d.answer!.providerMs) };
}

export function renderLatency(state: DashboardState) {
  const all = state.live.decisions.filter(d => d.answer).map(d => d.answer!.modelMs);
  const recent = all.slice(-600);
  setText($('lat-p50'), f.ms(f.quantile(recent, 0.5)));
  setText($('lat-p90'), f.ms(f.quantile(recent, 0.9)));
  setText($('lat-count'), recent.length ? `last ${recent.length} answers` : '');
  const pulse = state.live.pulse;
  setText($('lat-429'), f.int(pulse?.stats.rateLimited ?? 0));
  setText($('lat-timeouts'), f.int(pulse?.stats.timeouts ?? 0));
  setText($('lat-errors'), f.int(pulse?.stats.errors ?? 0));

  // The whole journey, using typical (middle) values: Coinbase to us, our own work, and Jev.
  const answered = state.live.decisions.filter(d => d.answer).slice(-600);
  const jev = f.quantile(recent, 0.5);
  const split = answered.filter(d => d.answer!.providerMs !== null);
  const model = f.quantile(split.map(d => d.answer!.providerMs!), 0.5);
  const route = f.quantile(split.map(d => d.answer!.modelMs - d.answer!.providerMs!), 0.5);
  const lag = pulse?.feed.lagMs ?? NaN;
  const handle = pulse?.eventCostUs ? pulse.eventCostUs.p50 / 1000 : NaN;
  setText($('bud-lag'), f.ms(lag));
  setText($('bud-handle'), Number.isFinite(handle) ? `${handle.toFixed(2)} ms` : '—');
  setText($('bud-jev'), f.ms(jev));
  setText($('bud-model'), f.ms(model));
  setText($('bud-route-label'), `of which ${routeLabel(pulse?.meta.provider)}`);
  setText($('bud-route'), f.ms(route));
  setText($('bud-total'), f.ms(lag + (Number.isFinite(handle) ? handle : 0) + jev));
}

// ---- market data: scoreboard -------------------------------------------------------------------

/** Money with the sign in front, so a loss reads as −$1.20 rather than $-1.20. */
const usdSigned = (x: number) => `${x > 0 ? '+' : x < 0 ? '\u2212' : ''}$${Math.abs(x).toFixed(2)}`;

/** What each card's rule is, in a sentence or two, shown under its numbers. */
const PNL_RULES: Record<PnlCard, (horizonS: number) => string> = {
  pnl: h =>
    `Every answer with a lean is traded, all the same size: take Jev's side at the mid price the moment the answer arrived, close ${h} seconds later. Jev's side is its answer read against what it has usually been saying over the last 15 minutes, because at face value it leans “down” most of the time whatever the market does next. “At face value” is what the same rule made without that correction.`,
  fpnl: () =>
    `The same calls, but only when the best level of the order book points the same way: when the two disagreed, Jev was right less than half the time. It also sits out if a headline from the last 15 minutes leans the other way. What is left is staked by how strong the lean is next to Jev's ordinary one, up to twice the normal stake.`,
  opnl: h =>
    `No Jev here: the order-book model (six measurements of the book, fitted on earlier days) says how far it expects the price to move in the next ${h} s, and a call is traded only when that is more than the round trip costs${h === 10 ? ', and only when the last minute was calm and the spread was one tick, where the model was right most often' : ''}. It is scored from the moment Jev's answer arrived, like the other two.`,
};

type PnlCard = 'pnl' | 'fpnl' | 'opnl';

/** What a round trip is charged, in words. */
const costWords = (pnl: Pnl) => (pnl.feeBpsPerSide === 0 ? 'no fees, only the spread' : `${f.fixed(pnl.feeBpsPerSide, 1)} bp a fill, twice, and the spread`);

/**
 * What one of the trading rules would have made at the chosen horizon. `prefix` selects which
 * card's elements to fill in, so the same code drives all three. `faceValue` is the plain rule
 * with Jev's answers taken as they came, shown on the first card as the yardstick for the
 * correction. `reach` says how close the order-book rule came to trading, for its card.
 */
export function renderPnl(prefix: PnlCard, pnl: Pnl | null, horizonS: number, faceValue: Pnl | null = null, reach: OrderBookReach[] = []) {
  const id = (suffix: string) => $(`${prefix}-${suffix}`);
  const leg = pnl?.legs.find(l => l.horizonS === horizonS);
  const total = id('money');
  setText(id('sub'), pnl && pnl.n > 0 ? `${f.int(pnl.n)} finished decisions · held ${horizonS} s each` : '');
  if (prefix === 'pnl') {
    // The same rule on the same decisions, without the correction: is reading Jev against its usual lean still paying?
    const was = faceValue?.legs.find(l => l.horizonS === horizonS);
    const judged = was ? was.right + was.wrong : 0;
    setText(id('face'), was && was.trades > 0 ? `${f.bp(was.totalBps)}${judged > 0 ? ` · ${f.pct(was.right / judged)} your way` : ''}` : '—');
  }
  const near = reach.find(r => r.horizonS === horizonS);
  // Why the order-book rule did or did not trade: its best expectation next to the cost.
  const why =
    prefix === 'opnl' && near && near.calls > 0
      ? `Of ${f.int(near.calls)} calls, ${f.int(near.calm)} came ${horizonS === 10 ? 'in a calm enough market' : 'with a price to trade'}; the biggest move the model expected among them was ${near.largestBps === null ? '—' : `${f.fixed(near.largestBps, 2)} bp`}, against a round trip of ${near.meanCostBps === null ? '—' : `${f.fixed(near.meanCostBps, 2)} bp`}.`
      : '';
  if (!pnl || !leg || leg.trades === 0) {
    total.className = 'pnl-money';
    setText(total, '—');
    setText(id('bps'), ' ');
    setText(id('stake'), pnl ? `a round trip: ${costWords(pnl)}` : '');
    for (const suffix of ['trades', 'win', 'flat', 'avg', 'best', 'worst', 'dd', 'gross', 'cost']) setText(id(suffix), '—');
    setHtml(
      id('note'),
      prefix === 'pnl'
        ? `A trade only counts once the price ${horizonS} seconds after the answer is known, so this fills in about a minute behind the decisions themselves. A new run also spends its first minute learning Jev's usual lean, and makes no calls until it has.`
        : prefix === 'fpnl'
          ? `Fills in the same way, once there have been enough calls that also clear its filters below.`
          : reach.some(r => r.calls > 0) && !near?.calls
            ? `The order-book model has no ${horizonS} s version: the research behind it looked at 10 and 60 seconds only (docs/accuracy.md).`
            : `${why || 'Fills in once the pipeline is sending the order-book model’s calls.'} No trade is the expected result at any fee Coinbase publishes: the model’s best calls expect well under a basis point, and a taker round trip costs at least 10 (docs/accuracy.md). Set FEE_BPS_PER_SIDE=0 to see what it would do with no fees.`,
    );
    return;
  }

  const dollars = (leg.totalBps / 10_000) * pnl.notionalUsd;
  total.className = `pnl-money ${leg.totalBps > 0 ? 'up' : leg.totalBps < 0 ? 'down' : ''}`;
  setText(total, usdSigned(dollars));
  setText(id('bps'), `${f.bp(leg.totalBps)} in all, after costs`);
  const averageStake = leg.trades > 0 ? (leg.staked / leg.trades) * pnl.notionalUsd : pnl.notionalUsd;
  setHtml(
    id('stake'),
    `${prefix === 'fpnl' ? `$${f.int(pnl.notionalUsd)} on an ordinary lean<br>$${f.int(averageStake)} a trade on average` : `$${f.int(pnl.notionalUsd)} a trade`}<br>a round trip: ${costWords(pnl)}`,
  );
  const called = leg.right + leg.wrong;
  setText(id('trades'), f.int(leg.trades));
  setText(id('win'), called > 0 ? f.pct(leg.right / called) : '—');
  setText(id('flat'), f.int(leg.trades - called));
  setText(id('avg'), f.bp(leg.avgBps, 2));
  setText(id('best'), f.bp(leg.bestBps));
  setText(id('worst'), f.bp(leg.worstBps));
  setText(id('dd'), f.bp(-leg.maxDrawdownBps));
  setText(id('gross'), f.bp(leg.grossBps));
  setText(id('cost'), f.bp(-leg.costBps));

  const paid = leg.wins + leg.losses;
  setHtml(
    id('note'),
    `${PNL_RULES[prefix](horizonS)} Trades overlap, so this assumes you could hold several at once.${why ? `<br>${why}` : ''}<br>
     “Went your way” is a share of the ${f.int(called)} trades where the price actually moved, before any cost: over ${horizonS} s it often does not move at all. ${paid > 0 ? `After costs, ${f.pct(leg.wins / paid)} of trades made money.` : ''}<br>
     Prices are mid-to-mid, and every trade is charged ${costWords(pnl)} (FEE_BPS_PER_SIDE); “before costs” is what the moves alone were worth.`,
  );
}

export function renderScoreboard(board: Scoreboard | null) {
  const el = $('scoreboard');
  if (!board || board.n === 0) {
    setHtml(el, `<p class="footnote">Fills in a minute after the first decisions: each one is scored once the price 60 seconds later is known.</p>`);
    setText($('score-n'), '');
    return;
  }
  setText($('score-n'), `${f.int(board.n)} finished decisions this run`);
  // A share of three or four decisions means nothing, so it is not shown until there are enough.
  const MIN_JUDGED = 20;
  const shown = (c: { hit: number | null; judged: number }) => (c.hit !== null && c.judged >= MIN_JUDGED ? c.hit : null);
  const best = board.horizons.map((_, i) => Math.max(...board.rows.map(r => shown(r.cells[i]!) ?? -1)));
  const rows = board.rows
    .map(
      r => `<tr class="${r.isJev ? 'jev' : ''}"><td>${f.esc(r.label)}</td>${r.cells
        .map((c, i) => {
          const hit = shown(c);
          return `<td class="${hit !== null && hit === best[i] ? 'best' : ''}" title="${c.judged} decisions where both the signal and the price had a direction">${hit === null ? '—' : f.pct(hit)}<small>${hit === null ? `${c.judged} of ${MIN_JUDGED}` : `rank ${f.signed(c.ic)}`}</small></td>`;
        })
        .join('')}</tr>`,
    )
    .join('');
  const beyond = board.beyond.map(b => `${b.horizonS} s <b>${b.n >= 60 ? f.signed(b.ic) : '—'}</b>`).join(' · ');
  setHtml(
    el,
    `<table class="score"><thead><tr><th>pointed the right way</th>${board.horizons.map(h => `<th>${h} s<span class="wide-only"> ahead</span></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
     <p class="footnote">Only decisions where the price actually moved are counted, and a score appears once there are ${MIN_JUDGED} of them, so a quiet market fills this slowly. "rank" is how well the signal ordered the moves (−1 to +1, 0 = no relationship). Jev is judged from when its answer arrived; the rules, which take no time, from the snapshot.<br>
     What is left of Jev's score once the four rules are accounted for: ${beyond}. Near zero means Jev is repeating what the rules already say.</p>`,
  );
}

// ---- news ------------------------------------------------------------------------------------

export function renderNewsSummary(state: DashboardState) {
  const pulse = state.news.pulse;
  if (!pulse) return;
  providerBadge($('news-badge'), pulse.meta.provider);
  const s = pulse.stats;
  const counter = (label: string, value: string) => `<div class="counter"><span>${label}</span><b>${value}</b></div>`;
  setHtml($('news-counters'), counter('headlines in', f.int(s.received)) + counter('Jev asked', f.int(s.decisions)) + counter('waiting', f.int(pulse.queued)) + counter('spent', f.usd(s.costUsd)));
  const chip = (label: string, n: number, cls = '') => (n > 0 ? `<span class="chip ${cls}">${label} <b>${f.int(n)}</b></span>` : '');
  const skipped =
    chip('repeats', s.duplicates) +
    chip('market closed', s.closed) +
    chip('no usable price', s.unpriced) +
    chip("can't price", s.unpriceable) +
    chip('dropped', s.dropped, 'warn') +
    chip('refused', s.rateLimited, 'warn') +
    chip('retried', s.retries, 'warn') +
    chip('lost', s.errors, 'warn');
  setHtml($('news-skips'), skipped ? `<span class="chip">not asked:</span>${skipped}` : `<span class="chip">every headline so far could be asked about</span>`);

  const stocks = pulse.stocks;
  setText($('stocks-slots'), stocks ? `stock prices: ${stocks.watching} of ${stocks.max} slots${stocks.rejected ? ` · ${stocks.rejected} over the limit` : ''}${stocks.reconnects ? ` · ${stocks.reconnects} reconnects` : ''}` : 'no stock prices (Alpaca keys missing)');
  setHtml(
    $('sources'),
    pulse.sources
      .map(src => {
        const pushed = src.polls === 0;
        const detail = pushed ? `pushed to us · ${f.int(src.items)} items` : `${f.int(src.polls)} checks · ${f.int(src.items)} items`;
        return `<div class="source" data-state="${src.errors > 0 ? 'stale' : 'live'}"><div class="source-name"><i class="dot"></i>${f.esc(src.name)}</div><p>${detail}${src.errors ? ` · ${src.errors} errors` : ''}</p></div>`;
      })
      .join(''),
  );
}

const SKIP_WORDS: Record<string, string> = {
  unpriceable: "Not asked: it's about something we have no prices for.",
  repeat: 'Not asked: it repeats a headline from the last half hour.',
  closed: 'Not asked: the US market is closed, so the outcome could not be measured.',
  unpriced: 'Not asked: no usable price right now.',
  dropped: 'Dropped: it waited too long for Jev.',
  lost: 'Lost: the call to Jev kept failing.',
};

function hue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function itemHtml(n: NewsEntry) {
  const tags = n.symbols === null ? '<span class="tag">general news</span>' : n.symbols.map(s => `<span class="tag">${f.esc(s)}</span>`).join('');
  const lag = n.publishedTs ? `<span>${Math.max(0, Math.round((n.recvTs - n.publishedTs) / 1000))} s after publishing</span>` : '';
  const head = n.url ? `<a href="${f.esc(n.url)}" target="_blank" rel="noopener noreferrer">${f.esc(n.headline)}</a>` : f.esc(n.headline);
  let body: string;
  if (n.answer) {
    const a = n.answer;
    body = `<div class="verdicts">${a.verdicts
      .map((v, i) => {
        const bull = v.direction.bullish ?? 0;
        const bear = v.direction.bearish ?? 0;
        const lean = bull >= bear ? (['up', 'bullish', bull] as const) : (['down', 'bearish', bear] as const);
        const direction = Math.max(bull, bear) < 0.5 ? `<span class="chip">no clear direction</span>` : `<span class="chip ${lean[0]}">${lean[1]} <b>${f.pct(lean[2])}</b></span>`;
        const moves = Object.entries(n.outcomes?.[v.symbol] ?? {})
          .filter(([h, m]) => m !== null && ['60', '300', '1800'].includes(h))
          .map(([h, m]) => `<span class="chip ${m! > 0 ? 'up' : m! < 0 ? 'down' : ''}">${Number(h) / 60} min later <b>${f.bp(m)}</b></span>`)
          .join('');
        return `<div class="verdict"><span class="who">${f.esc(v.symbol)}</span><span class="chip">matters <b>${f.fixed(v.relevant)}</b></span>${direction}<span class="chip">size <b>${f.fixed(v.magnitude, 1)}</b>/3</span>${
          i === 0 ? `<span class="chip accent">new <b>${f.fixed(a.novel)}</b></span><span class="chip">${f.ms(a.modelMs)}${a.attempts > 1 ? ` · try ${a.attempts}` : ''}</span>` : ''
        }${moves}</div>`;
      })
      .join('')}</div><details><summary>what Jev was shown</summary><pre>${f.esc(JSON.stringify(a.state, null, 2))}</pre></details>`;
  } else if (n.skip) body = `<div class="item-note">${SKIP_WORDS[n.skip.reason] ?? 'Not asked.'} <span class="muted">${f.esc(n.skip.detail)}</span></div>`;
  else if (n.status === 'earlier') body = `<div class="item-note">Arrived before this dashboard started, so what Jev made of it wasn't seen. It appears once its 30-minute outcome is saved.</div>`;
  else if (n.retry) body = `<div class="item-note waiting">Trying again: ${f.esc(n.retry.message)}</div>`;
  else body = `<div class="item-note waiting">Asking Jev…</div>`;
  return `<div class="item-meta"><time>${f.clock(n.recvTs)}</time><span class="src" style="--src:hsl(${hue(n.source)} 70% 62%)">${f.esc(n.sourceLabel)}</span>${tags}${lag}</div><h3>${head}</h3>${body}`;
}

const rows = new Map<string, { el: HTMLElement; html: string }>();

/** Newest first. Rows are created once and rewritten only when their item changes. */
export function renderFeed(items: NewsEntry[]) {
  const feed = $('feed');
  $('feed-empty').hidden = items.length > 0;
  setText($('feed-count'), items.length ? `${items.length} most recent` : '');
  const shown = items.slice(-150);
  const keys = new Set<string>();
  for (const n of shown) {
    const key = `${n.run}:${n.id}:${n.recvTs}`;
    keys.add(key);
    const html = itemHtml(n);
    const row = rows.get(key);
    if (!row) {
      const el = document.createElement('div');
      el.className = `item${n.skip || n.status === 'earlier' ? ' skipped' : ''}`;
      el.innerHTML = html;
      feed.prepend(el);
      rows.set(key, { el, html });
    } else if (row.html !== html) {
      const open = row.el.querySelector('details')?.open ?? false;
      row.el.className = `item${n.skip || n.status === 'earlier' ? ' skipped' : ''}`;
      row.el.style.animation = 'none';
      row.el.innerHTML = html;
      if (open) row.el.querySelector('details')?.setAttribute('open', '');
      row.html = html;
    }
  }
  for (const [key, row] of rows) {
    if (keys.has(key)) continue;
    row.el.remove();
    rows.delete(key);
  }
}

// ---- the chart's tooltip ---------------------------------------------------------------------

export function tooltipHtml(d: Decision, horizonS: number) {
  const a = d.answer!;
  const rows = HORIZONS.map(h => {
    const p = a.probabilities[`dir_${h}s`];
    const lean = actedLean(a.signals, h) ?? 0;
    return `<div class="tt-row"><span>${h} s</span>${probHtml(p, true)}<b class="${lean > 0.05 ? 'ok' : lean < -0.05 ? 'bad' : ''}">${f.signed(lean)}</b></div>`;
  }).join('');
  const move = d.outcome?.fromResp[String(horizonS)];
  const signal = actedLean(a.signals, horizonS) ?? 0;
  let verdict = `<span>${horizonS} s later: not known yet</span>`;
  if (typeof move === 'number') {
    const judged = move !== 0 && Math.abs(signal) >= 0.05;
    const right = judged && Math.sign(move) === Math.sign(signal);
    verdict = `<span>${horizonS} s later: <b class="${judged ? (right ? 'ok' : 'bad') : ''}">${f.bp(move, 2)}</b>${judged ? (right ? ' · right way' : ' · wrong way') : ''}</span>`;
  }
  return `<div class="tt-head"><span>#${d.id} · ${f.clock(a.tResp)}</span><span>${f.ms(a.modelMs)}</span></div>${rows}<div class="tt-foot">${verdict}</div>`;
}
