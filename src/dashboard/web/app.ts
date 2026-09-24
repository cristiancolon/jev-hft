// The page's entry point: get the current state, follow the live stream, and keep the screen
// up to date. All the work here happens in the browser; none of it reaches the pipeline.

import { DashboardState, type DashboardEvent, type DashboardSnapshot } from '../collector.ts';
import { EquityChart, LatencyChart, PriceChart } from './charts.ts';
import * as f from './format.ts';
import * as view from './views.ts';

let state = new DashboardState();
/** When we last heard from each program, on this browser's clock (null: never). */
const heard: Record<'live' | 'news', number | null> = { live: null, news: null };
/** Which cards need redrawing on the next frame. */
const dirty = new Set<string>();

const chart = new PriceChart(view.$<HTMLCanvasElement>('chart'));
const latency = new LatencyChart(view.$<HTMLCanvasElement>('latency-chart'));
const equity = new EquityChart(view.$<HTMLCanvasElement>('equity-chart'));
const fequity = new EquityChart(view.$<HTMLCanvasElement>('fequity-chart'));
const oequity = new EquityChart(view.$<HTMLCanvasElement>('oequity-chart'));
const nequity = new EquityChart(view.$<HTMLCanvasElement>('nequity-chart'));
/** The horizon the chart marks and the profit and loss is worked out for. */
let horizonS = 10;
/** How long the news card holds each headline's trade: 30 minutes, what Jev is asked about, unless another is picked. */
let newsHorizonS = 1800;
view.buildHorizons();
view.buildGauges();

// The pipeline's clock and this browser's may differ (it can run on another machine), so ages
// are worked out from when messages reached us rather than by comparing the two clocks.
let clockOffset = 0; // pipeline time minus browser time, from the newest message
const msSince = (pipelineT: number) => Date.now() + clockOffset - pipelineT;

// ---- staying in sync ---------------------------------------------------------------------------

let buffered: DashboardEvent[] | null = []; // stream messages that arrive before the first snapshot

async function loadSnapshot() {
  const snapshot = (await (await fetch('/api/snapshot')).json()) as DashboardSnapshot;
  state = DashboardState.from(snapshot);
  for (const program of ['live', 'news'] as const) {
    const rx = snapshot[program].lastRx;
    heard[program] = rx === null ? null : performance.now() - (snapshot.serverTime - rx);
  }
  for (const e of buffered ?? []) accept(e);
  buffered = null;
  for (const card of ['hero', 'chart', 'answer', 'gauges', 'latency', 'score', 'pnl', 'news', 'feed']) dirty.add(card);
}

function accept(e: DashboardEvent) {
  if (!state.apply(e)) return;
  if ('t' in e) {
    clockOffset = e.t - Date.now();
    heard[e.program] = performance.now();
  }
  switch (e.type) {
    case 'pulse':
      dirty.add(e.program === 'live' ? 'hero' : 'news');
      if (e.program === 'live') dirty.add('chart');
      break;
    case 'ask':
      dirty.add('gauges');
      break;
    case 'answer':
      for (const card of ['answer', 'latency', 'chart']) dirty.add(card);
      break;
    case 'fail':
      dirty.add('latency');
      break;
    case 'outcome':
      dirty.add('chart');
      break;
    case 'scoreboard':
      dirty.add('score');
      break;
    case 'pnl':
      dirty.add('pnl');
      break;
    default:
      dirty.add('feed');
  }
}

function connect() {
  const stream = new EventSource('/api/stream');
  const label = view.$('stream-state');
  stream.onopen = () => {
    label.textContent = 'connected';
    label.dataset.ok = 'true';
    // After a dropped connection we may have missed messages, so start again from a snapshot.
    buffered ??= [];
    void loadSnapshot().catch(() => {});
  };
  stream.onerror = () => {
    label.textContent = 'dashboard server not reachable, retrying…';
    label.dataset.ok = 'false';
  };
  stream.onmessage = message => {
    for (const e of JSON.parse(message.data) as DashboardEvent[]) {
      if (buffered) buffered.push(e);
      else accept(e);
    }
  };
}

// ---- drawing: at most once per frame, and only what changed ----------------------------------

function frame() {
  if (dirty.size > 0) {
    // This side stays up after the pipeline stops: the scoreboard and the profit and loss come
    // from the files it left behind, and a finished run is exactly when you want to read them.
    const live = state.live.pulse !== null || (state.pnl?.asAnswered.n ?? 0) > 0;
    const news = state.news.pulse !== null || state.news.items.length > 0;
    view.$('live-empty').hidden = live;
    view.$('live-body').hidden = !live;
    // With no telemetry coming in, only the cards read from the saved records have anything to say.
    const running = state.live.pulse !== null;
    view.$('live-body').dataset.running = String(running);
    view.$('live-stopped').hidden = running;
    view.$('news-empty').hidden = news;
    view.$('news-body').hidden = !news;

    if (live) {
      if (dirty.has('hero')) view.renderHero(state, chart.windowMs);
      if (dirty.has('chart')) chart.setData(state.live.ticks, state.live.decisions);
      if (dirty.has('answer')) view.renderLatestAnswer(state, msSince);
      if (dirty.has('gauges')) view.renderGauges(state);
      if (dirty.has('latency')) {
        const series = view.latencySeries(state);
        latency.setData(series.total, series.model);
        view.renderLatency(state);
      }
      if (dirty.has('score')) view.renderScoreboard(state.scoreboard);
      if (dirty.has('pnl')) {
        view.renderPnl('pnl', state.pnl?.corrected ?? null, horizonS, state.pnl?.asAnswered ?? null);
        view.renderPnl('fpnl', state.pnl?.selective ?? null, horizonS);
        // A dashboard server from before the order-book rule existed sends no such card.
        view.renderPnl('opnl', state.pnl?.orderBook ?? null, horizonS);
        equity.setData(state.pnl?.corrected.legs.find(l => l.horizonS === horizonS)?.curve ?? []);
        fequity.setData(state.pnl?.selective.legs.find(l => l.horizonS === horizonS)?.curve ?? []);
        oequity.setData(state.pnl?.orderBook?.legs.find(l => l.horizonS === horizonS)?.curve ?? []);
        // A dashboard server from before the news rule existed sends no such card either.
        view.renderPnl('npnl', state.pnl?.news ?? null, newsHorizonS);
        nequity.setData(state.pnl?.news?.legs.find(l => l.horizonS === newsHorizonS)?.curve ?? []);
      }
    }
    if (news) {
      if (dirty.has('news')) view.renderNewsSummary(state);
      if (dirty.has('feed')) view.renderFeed(state.news.items);
    }
    dirty.clear();
  }
  requestAnimationFrame(frame);
}

// Once a second: the clock, the "is it still alive" lights, ages, and the running total.
function everySecond() {
  view.$('clock').textContent = f.clock(Date.now());
  for (const program of ['live', 'news'] as const) {
    const since = heard[program] === null ? null : performance.now() - heard[program]!;
    const pulse = state[program].pulse;
    view.renderPill(program, view.liveness(since), pulse?.meta.provider, pulse?.run, since);
  }
  view.$('total-cost').textContent = f.usd((state.live.pulse?.stats.costUsd ?? 0) + (state.news.pulse?.stats.costUsd ?? 0));
  if (state.live.decisions.length > 0) dirty.add('answer'); // keeps "3 s ago" current
}

// ---- controls -------------------------------------------------------------------------------

function segmented(id: string, onPick: (value: number) => void) {
  const group = view.$(id);
  group.addEventListener('click', e => {
    const button = (e.target as HTMLElement).closest('button');
    if (!button) return;
    for (const b of group.querySelectorAll('button')) b.classList.toggle('on', b === button);
    onPick(Number(button.dataset.v));
  });
}
segmented('seg-window', ms => {
  chart.windowMs = ms;
  chart.invalidate();
  dirty.add('hero');
});
segmented('seg-horizon', s => {
  horizonS = s;
  chart.horizonS = s;
  chart.invalidate();
  dirty.add('pnl');
});
segmented('seg-news-horizon', s => {
  newsHorizonS = s;
  dirty.add('pnl');
});

// Dark / light. Follows the system until the button is used; after that the choice is remembered.
function setTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
  document.dispatchEvent(new Event('themechange')); // the charts re-read their colours
}
view.$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  setTheme(next);
});
matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
  if (!localStorage.getItem('theme')) setTheme(e.matches ? 'light' : 'dark');
});

const tip = view.$('chart-tip');
chart.onHover = hover => {
  if (!hover?.decision.answer) return void (tip.hidden = true);
  tip.innerHTML = view.tooltipHtml(hover.decision, chart.horizonS);
  tip.hidden = false;
  const wrap = tip.parentElement!.getBoundingClientRect();
  const left = hover.x + 18 + tip.offsetWidth > wrap.width ? hover.x - tip.offsetWidth - 18 : hover.x + 18;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, Math.min(hover.y - 40, wrap.height - tip.offsetHeight - 8))}px`;
};

connect();
requestAnimationFrame(frame);
everySecond();
setInterval(everySecond, 1000);
