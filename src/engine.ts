// Live decision loop: market events -> state -> decision record, once a second.
// Every stage is timestamped so the analyzer can attribute latency, and each record
// waits for its forward mids before being written.
//
// A decision is the order-book model's call (src/model/ridge.ts). Jev is asked as well only when
// JEV_MARKET=1: over five days its calls added nothing the book didn't already say, and never
// came near paying for a trade, while using nearly all of the account's credits (docs/decisions.md
// D63). Without Jev, a decision is acted on a fixed moment after its snapshot instead of when an
// answer arrives.

import type { Experimental_EvaluationModel as EvaluationModel } from 'ai';
import { config } from './config.ts';
import { nowMs, type MarketEvent } from './feed/types.ts';
import { Backoff } from './lib/backoff.ts';
import { encode } from './market/encode.ts';
import { bookShape } from './market/microstructure.ts';
import { MarketState, type Features } from './market/state.ts';
import { decide, directionSignal, flatThresholds, isOutOfCredits, isTimeout, RateLimitedError, type DirectionId, type FlatThresholds, type ModelResult } from './model/jev.ts';
import { LeanBook, type LeanReading } from './model/lean.ts';
import { orderBookSignals } from './model/ridge.ts';
import type { Emit } from './telemetry/events.ts';

export type DecisionRecord = {
  /** Record format version. Files written before versions existed have none. */
  v?: 2;
  mode: 'live' | 'backtest';
  provider: string;
  tState: number; // state snapshot (local clock, epoch ms)
  exchLagMs: number; // tState minus exchange time of the newest event in the state
  buildMs: number; // features + encoding
  modelMs: number; // model round trip (backtest: simulated)
  providerMs?: number; // the part of modelMs that was Jev itself; the rest is the network (and the gateway, on that route)
  tResp: number; // decision available to act on
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number; // list price of the call
  /** Which build of Jev answered ("jev-1.13.0"), when the route says. Only the direct API does. */
  modelVersion?: string;
  /** Exactly what Jev was sent; empty when Jev was not asked. */
  state: string;
  /** The move that counted as "flat" in each question (v2; before that, the fixed DIRECTIONS values). */
  flatBps?: FlatThresholds;
  /** Jev's answer. None when Jev was not asked (provider "none", D63). */
  probabilities?: ModelResult['probabilities'];
  /** TypeSafe's confidence in each answer: the probability of the answer it picked, which is usually "flat". */
  confidence?: Record<string, number>;
  /**
   * What Jev's lean had usually been in the minutes before this answer, per question. Unknown
   * (saved as null) until enough answers have arrived. Records from before this existed have none.
   */
  lean?: Record<DirectionId, LeanReading>;
  /**
   * Directional signals: Jev per horizon as answered (`jev_*`), the same with its usual lean
   * taken out (`jevc_*`, src/model/lean.ts), the zero-latency baselines, and the order-book
   * model's expected move in bps (`ob_10s`, `ob_60s`, src/model/ridge.ts).
   */
  signals: Record<string, number>;
  /** Best bid and ask at the snapshot. Records from before costs were charged have none. */
  quote?: { bid: number; ask: number };
  /** Best bid and ask when the answer arrived: what a trade placed then would have crossed. Live runs only. */
  quoteResp?: { bid: number; ask: number };
  /** 60-second volatility at the snapshot, bps. The order-book model is right more often when it is low. */
  vol60?: number;
  midState: number;
  midResp: number;
  /** Horizon seconds -> mid at tState + H and at tResp + H. */
  fwdState: Record<number, number>;
  fwdResp: Record<number, number>;
};

export function baselineSignals(f: Features) {
  return { obi1: f.imb1, obi5: f.imb5, flow5: f.flow5, mom5: f.ret5 };
}

export function jevSignals(p: ModelResult['probabilities']) {
  return { jev_2s: directionSignal(p.dir_2s), jev_10s: directionSignal(p.dir_10s), jev_60s: directionSignal(p.dir_60s) };
}

/**
 * The parts of a record that come from the model's answer, shared by live runs and backtests.
 * A backtest asks about many snapshots at once, so it has no "answers so far" to read a lean
 * against; it leaves `read` out and fills the readings in once every answer is in (fillLeans).
 */
export function answerFields(res: ModelResult, f: Features, flat: FlatThresholds, read?: ReturnType<LeanBook['take']>) {
  return {
    ...(res.meta.providerMs !== undefined ? { providerMs: res.meta.providerMs } : {}),
    ...(res.meta.inputTokens !== undefined ? { inputTokens: res.meta.inputTokens } : {}),
    ...(res.meta.outputTokens !== undefined ? { outputTokens: res.meta.outputTokens } : {}),
    ...(res.meta.costUsd !== undefined ? { costUsd: res.meta.costUsd } : {}),
    ...(res.meta.modelVersion !== undefined ? { modelVersion: res.meta.modelVersion } : {}),
    flatBps: flat,
    probabilities: res.probabilities,
    ...(res.meta.confidence ? { confidence: res.meta.confidence } : {}),
    ...(read ? { lean: read.lean } : {}),
    signals: { ...jevSignals(res.probabilities), ...read?.signals, ...baselineSignals(f) },
  };
}

/**
 * What the order-book model expects, and the prices a trade would have crossed, from the book as
 * it stood at the snapshot. Shared by live runs and backtests.
 */
export function bookFields(f: Features, state: MarketState) {
  return { signals: orderBookSignals({ ...f, ...bookShape(state) }), quote: { bid: f.bid, ask: f.ask }, vol60: f.vol60 };
}

export function fillForward(rec: DecisionRecord, state: MarketState) {
  // A horizon that has not elapsed yet (run stopped early) is unknown, not "unchanged".
  const at = (t: number) => (t <= state.lastRecvTs ? state.midAt(t) : NaN);
  for (const h of config.horizons) {
    rec.fwdState[h] = at(rec.tState + h * 1000);
    rec.fwdResp[h] = at(rec.tResp + h * 1000);
  }
}

/**
 * How long after its snapshot a decision without Jev is acted on: the time the research allowed
 * for an order to reach the exchange, and what the order-book model was tested at (docs/accuracy.md).
 */
export const ACT_DELAY_MS = 300;

export class LiveEngine {
  readonly state = new MarketState();
  readonly stats = { decisions: 0, written: 0, rateLimited: 0, timeouts: 0, errors: 0, outOfCredits: 0, lastModelMs: NaN, costUsd: 0 };
  private inFlight = 0;
  private lastDecision = -Infinity;
  private readonly backoff = new Backoff();
  /** Out of credits: try again after a minute, then less and less often, up to every 15 minutes. */
  private readonly creditBackoff = new Backoff(60_000, 15 * 60_000);
  /** Jev's recent answers, which each new one is read against. */
  private readonly leans = new LeanBook();
  private readyAt = NaN;
  /** Answered decisions waiting for their forward prices, oldest first. */
  private pending: DecisionRecord[] = [];
  private readonly maxHorizonMs = Math.max(...config.horizons) * 1000;

  /** null: Jev is not asked, and each decision is the order-book model's alone. */
  private readonly model: EvaluationModel | null;
  private readonly actDelayMs: number;
  private readonly write: (r: DecisionRecord) => void;
  private readonly log: (s: string) => void;
  /** Tells the dashboard what is happening. Does nothing unless a runner wires it up. */
  private readonly emit: Emit;
  private asked = 0;

  constructor(model: EvaluationModel | null, write: (r: DecisionRecord) => void, log: (s: string) => void, emit: Emit = () => {}, actDelayMs = ACT_DELAY_MS) {
    this.model = model;
    this.actDelayMs = actDelayMs;
    this.write = write;
    this.log = log;
    this.emit = emit;
  }

  onEvent(e: MarketEvent) {
    this.state.apply(e);
    if (!this.state.ready) {
      this.readyAt = NaN;
      return;
    }
    if (Number.isNaN(this.readyAt)) this.readyAt = e.recvTs;
    this.flush(e.recvTs);
    this.maybeDecide(e.recvTs);
  }

  /** Write every pending record whose forward horizons have all elapsed (all of them if `force`). */
  flush(now: number, force = false) {
    while (this.pending.length > 0 && (force || now >= this.pending[0]!.tResp + this.maxHorizonMs)) {
      const rec = this.pending.shift()!;
      fillForward(rec, this.state);
      this.write(rec);
      this.stats.written++;
    }
  }

  private maybeDecide(now: number) {
    if (
      !this.state.ready ||
      now - this.readyAt < config.warmupMs ||
      this.inFlight >= config.maxInFlight ||
      now - this.lastDecision < config.minIntervalMs ||
      this.backoff.waiting(now) ||
      this.creditBackoff.waiting(now)
    )
      return;
    this.lastDecision = now;
    void (this.model ? this.decideNow(this.model) : this.bookOnly());
  }

  /**
   * A decision without Jev: the order-book model's call, from the book at the snapshot, acted on
   * `actDelayMs` later at the prices then. The dashboard is told what the book looked like, as it
   * is when Jev is asked, but there is no answer to tell it about.
   */
  private async bookOnly() {
    const tState = nowMs();
    const f = this.state.features(tState);
    const book = bookFields(f, this.state);
    const tBuilt = nowMs();
    const id = ++this.asked;
    this.inFlight++;
    try {
      this.emit({
        type: 'ask',
        program: 'live',
        id,
        tState,
        state: '',
        flatBps: flatThresholds(f.vol60, config.flatSigmas),
        features: { mid: f.mid, spreadBps: f.spreadBps, imb1: f.imb1, imb5: f.imb5, imb20: f.imb20, ret5: f.ret5, ret60: f.ret60, vol60: f.vol60, flow5: f.flow5, trades5: f.trades5 },
      });
      if (this.actDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.actDelayMs));
      this.stats.decisions++;
      this.pending.push({
        v: 2,
        mode: 'live',
        provider: 'none',
        tState,
        exchLagMs: tState - f.exchTs,
        buildMs: tBuilt - tState,
        modelMs: 0,
        tResp: nowMs(),
        state: '',
        signals: { ...baselineSignals(f), ...book.signals },
        quote: book.quote,
        quoteResp: { bid: this.state.book.bestBid, ask: this.state.book.bestAsk },
        vol60: book.vol60,
        midState: f.mid,
        midResp: this.state.book.mid,
        fwdState: {},
        fwdResp: {},
      });
    } finally {
      this.inFlight--;
    }
  }

  private async decideNow(model: EvaluationModel) {
    const tState = nowMs();
    const f = this.state.features(tState);
    const text = encode(f, this.state, config.product, config.encoding);
    const flat = flatThresholds(f.vol60, config.flatSigmas);
    const tBuilt = nowMs();
    const id = ++this.asked;
    this.inFlight++;
    try {
      // The request is started first and reported second, so telemetry is never in its way.
      const answer = decide(model, text, flat, AbortSignal.timeout(config.timeoutMs));
      this.emit({
        type: 'ask',
        program: 'live',
        id,
        tState,
        state: text,
        flatBps: flat,
        features: { mid: f.mid, spreadBps: f.spreadBps, imb1: f.imb1, imb5: f.imb5, imb20: f.imb20, ret5: f.ret5, ret60: f.ret60, vol60: f.vol60, flow5: f.flow5, trades5: f.trades5 },
      });
      // Worked out after the request has been started, like the telemetry above, from the book
      // as it stands now, which is the book the snapshot saw (nothing else runs in between).
      const book = bookFields(f, this.state);
      const res = await answer;
      const tResp = nowMs();
      this.backoff.succeed();
      this.creditBackoff.succeed();
      this.stats.decisions++;
      this.stats.lastModelMs = tResp - tBuilt;
      this.stats.costUsd += res.meta.costUsd ?? 0;
      const answered = answerFields(res, f, flat, this.leans.take(tResp, res.probabilities));
      this.pending.push({
        v: 2,
        mode: 'live',
        provider: config.provider,
        tState,
        exchLagMs: tState - f.exchTs,
        buildMs: tBuilt - tState,
        modelMs: tResp - tBuilt,
        tResp,
        state: text,
        ...answered,
        signals: { ...answered.signals, ...book.signals },
        quote: book.quote,
        quoteResp: { bid: this.state.book.bestBid, ask: this.state.book.bestAsk },
        vol60: book.vol60,
        midState: f.mid,
        midResp: this.state.book.mid,
        fwdState: {},
        fwdResp: {},
      });
      const rec = this.pending[this.pending.length - 1]!;
      this.emit({
        type: 'answer',
        program: 'live',
        id,
        tResp,
        modelMs: rec.modelMs,
        providerMs: rec.providerMs ?? null,
        inputTokens: rec.inputTokens ?? null,
        costUsd: rec.costUsd ?? null,
        probabilities: res.probabilities,
        confidence: rec.confidence ?? null,
        lean: rec.lean ?? null,
        signals: rec.signals,
        midResp: rec.midResp,
      });
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof RateLimitedError) {
        this.stats.rateLimited++;
        const wait = this.backoff.fail(nowMs());
        this.log(`rate limited; pausing decisions ${(wait / 1000).toFixed(0)}s`);
        this.emit({ type: 'fail', program: 'live', id, kind: 'rate-limit', message });
      } else if (isOutOfCredits(error)) {
        this.stats.outOfCredits++;
        const wait = this.creditBackoff.fail(nowMs());
        this.log(`out of credits; asking again in ${(wait / 60_000).toFixed(0)} min (${message})`);
        this.emit({ type: 'fail', program: 'live', id, kind: 'error', message });
      } else if (isTimeout(error)) {
        this.stats.timeouts++;
        this.emit({ type: 'fail', program: 'live', id, kind: 'timeout', message });
      } else {
        this.stats.errors++;
        this.log(`model error: ${message}`);
        this.emit({ type: 'fail', program: 'live', id, kind: 'error', message });
      }
    } finally {
      this.inFlight--;
      this.maybeDecide(nowMs()); // refill the slot immediately rather than waiting for the next event
    }
  }
}
