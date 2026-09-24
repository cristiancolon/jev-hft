// What the dashboard knows, and how each incoming message changes it.
//
// This one file runs in two places: in the dashboard server, so a page that loads or reloads
// gets recent history at once, and in the browser, which keeps its own copy up to date from the
// live stream. Sharing it means the two can never disagree about what a message means.
//
// Because the browser loads it too, it must not use anything from Node.js, and it may import
// types only.

import type { Answer, Ask, Envelope, Fail, NewsAnswered, NewsArrived, NewsRetry, NewsSkipped, Pulse, TelemetryEvent } from '../telemetry/events.ts';

// ---- messages the dashboard server adds to the pipeline's own ----------------------------

/** What the price did after a decision, read from the pipeline's finished records. Basis points; null = unknown. */
export type LiveOutcome = {
  type: 'outcome';
  program: 'live';
  tState: number;
  /** horizon seconds -> move from the snapshot, and from when the answer arrived. */
  fromState: Record<string, number | null>;
  fromResp: Record<string, number | null>;
};

export type NewsOutcome = {
  type: 'news-outcome';
  program: 'news';
  id: string;
  recvTs: number;
  symbol: string;
  /** horizon seconds -> tradable move from when the answer arrived. */
  moves: Record<string, number | null>;
};

/** `judged`: decisions where both the signal and the move had a direction, which is what `hit` is a share of. */
export type ScoreCell = { horizonS: number; hit: number | null; ic: number | null; n: number; judged: number };
export type Scoreboard = {
  /** Finished decisions it is based on, and the time of the oldest. */
  n: number;
  since: number | null;
  horizons: number[];
  rows: { key: string; label: string; isJev: boolean; cells: ScoreCell[] }[];
  /** What is left of Jev's score once the simple rules are accounted for. */
  beyond: { horizonS: number; ic: number | null; n: number }[];
};
export type ScoreboardUpdate = { type: 'scoreboard'; program: 'live'; board: Scoreboard };

/** What following Jev's leans at one horizon would have made, in basis points of one normal stake. */
export type PnlLeg = {
  horizonS: number;
  /** Decisions that were actually traded (a strategy can sit some out). */
  trades: number;
  /** Trades that finished above and below water, after cost. Any left over neither made nor lost anything. */
  wins: number;
  losses: number;
  /** Trades whose price went the way the call said, and the other way, before any cost: how often the call itself was right. */
  right: number;
  wrong: number;
  /** After costs. */
  totalBps: number;
  /** What the moves alone were worth, and what trading them cost (fees on both fills and the spread); totalBps is the difference. */
  grossBps: number;
  costBps: number;
  /** Normal stakes put down in all: the same as `trades` for a rule that always bets one, less or more for one that sizes its bets. */
  staked: number;
  /** Made per normal stake put down. */
  avgBps: number | null;
  /** The best and worst single call, at full size, so these describe the call rather than the stake. */
  bestBps: number | null;
  worstBps: number | null;
  /** The largest fall from a high point of the running total. */
  maxDrawdownBps: number;
  /** The running total over time, thinned for drawing. */
  curve: { t: number; cumBps: number }[];
};
export type Pnl = {
  /** Finished decisions it is based on, and the time of the oldest. */
  n: number;
  since: number | null;
  /** The assumptions it was worked out under: the exchange's fee on each fill, in bps. */
  feeBpsPerSide: number;
  notionalUsd: number;
  legs: PnlLeg[];
  /** How near the rule came to trading, per horizon. A dashboard server from before D59 sends none. */
  reach: Reach[];
};
/**
 * `asAnswered`: Jev's answers at face value, all the same size. `corrected`: the same, with Jev's
 * usual lean taken out first. `selective`: the corrected lean, but only when the best level of the
 * order book agrees and no very recent headline disagrees, staking more on a stronger lean.
 * `orderBook`: the order-book model's call, at 10 s only in a calm market. Each takes a call only
 * when it is expected to catch more than the round trip costs (docs/dashboard.md).
 */
export type PnlSet = { asAnswered: Pnl; corrected: Pnl; selective: Pnl; orderBook: Pnl };
/**
 * How near a rule came to trading at one horizon; when it takes no trades, this is why. First,
 * every call it made whose outcome is known, as if each had been traded whatever it cost: how many,
 * how many went each way, what the moves were worth, what trading them would have cost, and the
 * stakes put down (the same measures as PnlLeg's). Then the calls it could weigh against the cost
 * (for Jev, those with enough earlier calls like them to judge by; for the order-book model, those
 * in a calm enough market), the most any of them was expected to catch, and what a round trip cost
 * on average among them.
 */
export type Reach = {
  horizonS: number;
  calls: number;
  right: number;
  wrong: number;
  grossBps: number;
  costBps: number;
  staked: number;
  weighed: number;
  largestBps: number | null;
  meanCostBps: number | null;
};
export type PnlUpdate = { type: 'pnl'; program: 'live'; pnl: PnlSet };

/** A headline from before the dashboard started, restored from what the pipeline saved to disk. */
export type NewsRestored = { type: 'news-restored'; program: 'news'; entry: NewsEntry };

export type ServerEvent = LiveOutcome | NewsOutcome | ScoreboardUpdate | PnlUpdate | NewsRestored;
/** `rx` is when the dashboard server received it; `seq` orders everything the server hands out. */
export type DashboardEvent = (TelemetryEvent | ServerEvent) & { rx: number; seq: number };

// ---- the state ---------------------------------------------------------------------------

export type Decision = Omit<Ask, 'type' | 'program'> & {
  run: number;
  answer?: Omit<Answer, 'type' | 'program' | 'id'>;
  failed?: { kind: Fail['kind']; message: string };
  outcome?: { fromState: Record<string, number | null>; fromResp: Record<string, number | null> };
};

export type NewsEntry = Omit<NewsArrived, 'type' | 'program'> & {
  run: number;
  /** 'earlier': it arrived before the dashboard was listening, so whether it was asked about is not known. */
  status: 'waiting' | 'answered' | 'skipped' | 'earlier';
  skip?: { reason: NewsSkipped['reason']; detail: string };
  retry?: { kind: NewsRetry['kind']; message: string };
  answer?: Omit<NewsAnswered, 'type' | 'program' | 'id'>;
  /** symbol -> horizon seconds -> move. */
  outcomes?: Record<string, Record<string, number | null>>;
};

export type Tick = { t: number; mid: number };
type LivePulse = Extract<Pulse, { program: 'live' }> & Envelope;
type NewsPulse = Extract<Pulse, { program: 'news' }> & Envelope;

export type DashboardSnapshot = {
  seq: number;
  /** The server's clock when the snapshot was taken, to judge how stale `lastRx` is. */
  serverTime: number;
  live: { lastRx: number | null; pulse: LivePulse | null; ticks: Tick[]; decisions: Decision[] };
  news: { lastRx: number | null; pulse: NewsPulse | null; ticks: Tick[]; items: NewsEntry[] };
  scoreboard: Scoreboard | null;
  pnl: PnlSet | null;
};

/**
 * The lean the pipeline acts on at one horizon: Jev's answer with its usual lean taken out
 * (src/model/lean.ts). null while that usual lean is not known yet, which is the first minute of
 * a run. A pipeline from before this existed sends only the answer itself, so that is used.
 */
export function actedLean(signals: Record<string, number | null>, horizonS: number): number | null {
  const corrected = `jevc_${horizonS}s`;
  return corrected in signals ? (signals[corrected] ?? null) : (signals[`jev_${horizonS}s`] ?? null);
}

/** Thirty minutes of one-a-second history, and a few hundred news items. */
export const LIMITS = { ticks: 1800, decisions: 1800, items: 300 };

const trim = <T>(xs: T[], max: number) => {
  if (xs.length > max) xs.splice(0, xs.length - max);
};

export class DashboardState {
  seq = 0;
  live: DashboardSnapshot['live'] = { lastRx: null, pulse: null, ticks: [], decisions: [] };
  news: DashboardSnapshot['news'] = { lastRx: null, pulse: null, ticks: [], items: [] };
  scoreboard: Scoreboard | null = null;
  pnl: PnlSet | null = null;

  static from(snapshot: DashboardSnapshot): DashboardState {
    const s = new DashboardState();
    s.seq = snapshot.seq;
    s.live = snapshot.live;
    s.news = snapshot.news;
    s.scoreboard = snapshot.scoreboard;
    s.pnl = snapshot.pnl;
    return s;
  }

  snapshot(serverTime: number): DashboardSnapshot {
    return { seq: this.seq, serverTime, live: this.live, news: this.news, scoreboard: this.scoreboard, pnl: this.pnl };
  }

  /** Returns false for a message that is already reflected (a stream and a snapshot can overlap). */
  apply(e: DashboardEvent): boolean {
    if (e.seq <= this.seq) return false;
    this.seq = e.seq;
    const fromPipeline = e.type !== 'scoreboard' && e.type !== 'pnl' && e.type !== 'outcome' && e.type !== 'news-outcome' && e.type !== 'news-restored';
    if (fromPipeline) this[e.program].lastRx = e.rx;

    switch (e.type) {
      case 'pulse':
        if (e.program === 'live') this.live.pulse = e;
        else this.news.pulse = e;
        if (e.market.mid !== null) {
          const ticks = this[e.program].ticks;
          ticks.push({ t: e.t, mid: e.market.mid });
          trim(ticks, LIMITS.ticks);
        }
        break;
      case 'ask': {
        const { type: _type, program: _program, v: _v, t: _t, rx: _rx, seq: _seq, ...ask } = e;
        this.live.decisions.push(ask);
        trim(this.live.decisions, LIMITS.decisions);
        break;
      }
      case 'answer': {
        const d = this.decision(e.run, e.id);
        if (d) {
          const { type: _type, program: _program, id: _id, v: _v, t: _t, run: _run, rx: _rx, seq: _seq, ...answer } = e;
          d.answer = answer;
        }
        break;
      }
      case 'fail': {
        const d = this.decision(e.run, e.id);
        if (d) d.failed = { kind: e.kind, message: e.message };
        break;
      }
      case 'outcome': {
        // A finished record and the live message about it carry the very same snapshot time.
        const d = this.live.decisions.findLast(x => x.tState === e.tState);
        if (d) d.outcome = { fromState: e.fromState, fromResp: e.fromResp };
        break;
      }
      case 'scoreboard':
        this.scoreboard = e.board;
        break;
      case 'pnl':
        this.pnl = e.pnl;
        break;
      case 'news-item': {
        const { type: _type, program: _program, v: _v, t: _t, rx: _rx, seq: _seq, ...item } = e;
        this.news.items.push({ ...item, status: 'waiting' });
        trim(this.news.items, LIMITS.items);
        break;
      }
      case 'news-skip': {
        const n = this.item(e.run, e.id);
        if (n) {
          n.status = 'skipped';
          n.skip = { reason: e.reason, detail: e.detail };
          delete n.retry;
        }
        break;
      }
      case 'news-retry': {
        const n = this.item(e.run, e.id);
        if (n) n.retry = { kind: e.kind, message: e.message };
        break;
      }
      case 'news-answer': {
        const n = this.item(e.run, e.id);
        if (n) {
          const { type: _type, program: _program, id: _id, v: _v, t: _t, run: _run, rx: _rx, seq: _seq, ...answer } = e;
          n.status = 'answered';
          n.answer = answer;
          delete n.retry;
        }
        break;
      }
      case 'news-restored': {
        const at = this.news.items.findIndex(x => x.id === e.entry.id && x.recvTs === e.entry.recvTs);
        if (at < 0) {
          this.news.items.push(e.entry);
          this.news.items.sort((a, b) => a.recvTs - b.recvTs);
          trim(this.news.items, LIMITS.items);
        } else if (this.news.items[at]!.status === 'earlier' && e.entry.answer) {
          // Its finished record has now been saved, so what Jev said is known after all.
          this.news.items[at] = { ...e.entry, outcomes: this.news.items[at]!.outcomes };
        }
        break;
      }
      case 'news-outcome': {
        // Finished records do not carry the run, so match on the id and the arrival time.
        const n = this.news.items.findLast(x => x.id === e.id && x.recvTs === e.recvTs);
        if (n) (n.outcomes ??= {})[e.symbol] = e.moves;
        break;
      }
    }
    return true;
  }

  private decision(run: number, id: number) {
    return this.live.decisions.findLast(d => d.run === run && d.id === id);
  }

  private item(run: number, id: string) {
    return this.news.items.findLast(n => n.run === run && n.id === id);
  }
}
