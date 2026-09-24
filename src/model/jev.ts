// The decision stage. `ask` wraps experimental_evaluate with pipeline semantics and is
// shared by the market-data path (`decide`, below) and the news path (src/news).
//
// JEV_PROVIDER selects the route:
//   typesafe (default) TypeSafe's own API (TYPESAFE_AI_API_KEY). Half the round trip of the
//                      gateway, because there is no extra hop: 122 ms against 255 ms (D52).
//   gateway            Vercel AI Gateway (AI_GATEWAY_API_KEY), model AI_GATEWAY_MODEL
//                      (default typesafe-ai/jev). Useful for billing in one place, or to
//                      compare the two routes.
//   mock               random answers after MOCK_LATENCY_MS; exercises the pipeline for free

import { createGateway } from '@ai-sdk/gateway';
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import {
  experimental_evaluate,
  type Experimental_EvaluationModel as EvaluationModel,
  type Experimental_EvaluationQuestion as Question,
} from 'ai';
import { performance } from 'node:perf_hooks';
import { Agent } from 'undici';
import { envNum } from '../config.ts';

// ---- connection --------------------------------------------------------------------
//
// Node closes an idle connection after 4 seconds, and the far end closes one after 30 to 60.
// News calls are minutes apart, so without help every one of them would first spend about
// 100 ms opening a new encrypted connection. Jev calls therefore get their own connection
// pool that keeps idle connections for 25 seconds, and `keepWarm` makes a tiny request every
// 20 seconds so the connection never sits idle long enough for either side to close it.

const KEEP_ALIVE_MS = 25_000;
const PING_MS = 20_000;

const dispatcher = new Agent({ keepAliveTimeout: KEEP_ALIVE_MS, keepAliveMaxTimeout: KEEP_ALIVE_MS });
const jevFetch: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);

/** Where each route's requests go. A GET there is refused at once (405) without any model call. */
const ENDPOINTS: Record<string, string> = {
  gateway: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model',
  typesafe: 'https://api.typesafe.ai/v1/systemone',
};

/**
 * Keep the connection to Jev open between calls. Returns a function that stops it.
 * GET, not HEAD: Node's HTTP client closes the connection after every HEAD request.
 */
export function keepWarm(provider: string, log: (s: string) => void): () => void {
  const url = ENDPOINTS[provider];
  if (!url) return () => {};
  let failures = 0;
  const ping = async () => {
    try {
      const res = await jevFetch(url, { signal: AbortSignal.timeout(5000) });
      await res.arrayBuffer();
      failures = 0;
    } catch (error) {
      // Harmless by itself (the next call just opens a new connection), so say it only once.
      if (++failures === 3) log(`keep-warm requests to ${new URL(url).host} are failing: ${(error as Error).message}`);
    }
  };
  void ping();
  const timer = setInterval(ping, PING_MS);
  return () => clearInterval(timer);
}

/** Close idle connections so a finished program can exit. */
export const closeConnections = () => dispatcher.close();

export function createModel(provider = process.env.JEV_PROVIDER || 'typesafe'): EvaluationModel {
  switch (provider) {
    case 'gateway':
      return createGateway({ fetch: jevFetch }).evaluationModel(process.env.AI_GATEWAY_MODEL || 'typesafe-ai/jev');
    case 'typesafe':
      return createTypeSafeAi({ fetch: jevFetch }).evaluationModel('jev-latest');
    case 'mock':
      return mockModel(envNum('MOCK_LATENCY_MS', 375, { min: 0 }));
    default:
      throw new Error(`Unknown JEV_PROVIDER "${provider}" (gateway | typesafe | mock)`);
  }
}

// ---- one call ------------------------------------------------------------------------

export class RateLimitedError extends Error {}

/**
 * The account has run out of credits. Unlike a rate limit this does not clear in seconds, and
 * asking once a second anyway is what filled the Pi's log with 91,729 identical failures over the
 * 27 hours the credits were gone (2026-09-22 to 23). Callers pause for minutes instead.
 */
export function isOutOfCredits(error: unknown): boolean {
  const e = error as { statusCode?: number; message?: string } | undefined;
  return e?.statusCode === 402 || /billing_error|no available .*credits/i.test(e?.message ?? '');
}

/**
 * Did the call run out of time? The gateway provider wraps whatever went wrong in its own error
 * type, so the timeout we set may be one or two levels down in the chain of causes.
 */
export function isTimeout(error: unknown): boolean {
  let e = error as { name?: string; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 5; depth++, e = e.cause as typeof e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || e.name === 'GatewayTimeoutError') return true;
  }
  return false;
}

/**
 * Failures that may well succeed a moment later: timeouts, network trouble, and errors on the
 * server's side (5xx). A rejected key or a malformed request (4xx) will fail the same way again.
 */
export function isTransient(error: unknown) {
  const status = (error as { statusCode?: number }).statusCode;
  return isTimeout(error) || status === undefined || status === 408 || status >= 500;
}

/** Facts about one call that come back alongside the answers. */
export type CallMeta = {
  inputTokens?: number;
  outputTokens?: number;
  /**
   * What the call cost at list price. The gateway reports this itself; TypeSafe's own API does
   * not, so there it is worked out from the tokens at `JEV_USD_PER_MTOK`.
   */
  costUsd?: number;
  /**
   * How long Jev itself took, leaving the network (and, on the gateway route, the gateway) as the
   * rest of the round trip. The gateway reports how long it waited for TypeSafe; TypeSafe's own
   * API reports its service time in a header.
   */
  providerMs?: number;
  /** TypeSafe's confidence in each choice or score answer, by question id. */
  confidence?: Record<string, number>;
  /** Which build of Jev answered, when the route says: the direct API does, the gateway does not. */
  modelVersion?: string;
};

type EvaluationState = Parameters<typeof experimental_evaluate>[0]['state'];
type EvaluationResult = Awaited<ReturnType<typeof experimental_evaluate>>;

type GatewayMetadata = {
  marketCost?: string;
  routing?: { modelAttempts?: { providerAttempts?: { startTime?: number; endTime?: number; success?: boolean }[] }[] };
};

/**
 * List price per million input tokens, used only when the route doesn't report a cost. Measured
 * against the gateway's own figures over 30,000 calls, which came to $0.042 per million to the
 * cent. Set `JEV_USD_PER_MTOK` if TypeSafe bills you at a different rate.
 */
const USD_PER_MTOK = envNum('JEV_USD_PER_MTOK', 0.042, { min: 0 });

/**
 * TypeSafe's own API resolves "jev-latest" to the build that actually answered ("jev-1.13.0").
 * The gateway echoes the route it was asked for ("typesafe-ai/jev"), and the practice model names
 * itself, neither of which is a version. Keep only a real one, so no record claims to know which
 * build answered when it was never told.
 */
const modelVersion = (id: string | undefined) => (id && /\d/.test(id) && !/[/\s]/.test(id) ? id : undefined);

function callMeta(result: EvaluationResult): CallMeta {
  const md = (result.providerMetadata ?? {}) as { typesafe?: { confidence?: Record<string, number> }; gateway?: GatewayMetadata };
  const { inputTokens, outputTokens } = result.usage;
  const attempt = md.gateway?.routing?.modelAttempts?.at(-1)?.providerAttempts?.at(-1);
  // The gateway's own accounting, or ours from the tokens when the route keeps no account.
  const reported = Number(md.gateway?.marketCost);
  const cost = Number.isFinite(reported) ? reported : inputTokens === undefined ? NaN : (inputTokens * USD_PER_MTOK) / 1e6;
  // The gateway times TypeSafe from outside; TypeSafe times itself and says so in a header.
  const service = Number(result.response.headers?.['x-envoy-upstream-service-time']);
  const gatewayMs = attempt?.startTime && attempt.endTime ? attempt.endTime - attempt.startTime : NaN;
  const providerMs = Number.isFinite(gatewayMs) ? gatewayMs : service;
  const version = modelVersion(result.response.modelId);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(Number.isFinite(cost) ? { costUsd: cost } : {}),
    ...(Number.isFinite(providerMs) ? { providerMs } : {}),
    ...(md.typesafe?.confidence ? { confidence: md.typesafe.confidence } : {}),
    ...(version ? { modelVersion: version } : {}),
  };
}

/** One Jev call. No retries (a retried answer is a stale answer); HTTP 429 becomes RateLimitedError. */
export async function ask<const Q extends Record<string, Question>>(
  model: EvaluationModel,
  state: EvaluationState,
  questions: Q,
  abortSignal?: AbortSignal,
) {
  try {
    const result = await experimental_evaluate({ model, state, questions, maxRetries: 0, abortSignal });
    return { answers: result.answers, meta: callMeta(result) };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 429) throw new RateLimitedError((error as Error).message);
    throw error;
  }
}

// ---- market-data questions -----------------------------------------------------------

/** Direction questions: horizon, and the move that counts as "flat" when volatility is unknown. */
export const DIRECTIONS = {
  dir_2s: { seconds: 2, flatBps: 0.5 },
  dir_10s: { seconds: 10, flatBps: 1 },
  dir_60s: { seconds: 60, flatBps: 3 },
} as const;

export type DirectionId = keyof typeof DIRECTIONS;
export type FlatThresholds = Record<DirectionId, number>;

const direction = (seconds: number, flatBps: number): Extract<Question, { type: 'choice' }> => ({
  type: 'choice',
  instructions: `Based on this order book and trade flow snapshot, where will the mid price be ${seconds} seconds from now, relative to the current mid?`,
  criteria: {
    up: `Higher by more than ${flatBps} basis points`,
    down: `Lower by more than ${flatBps} basis points`,
    flat: `Within ${flatBps} basis points of the current mid`,
  },
});

/**
 * The move that counts as "flat" for each horizon, scaled to how much the price is moving right
 * now: `sigmas` x (one-second volatility x sqrt(seconds)), the typical move over that horizon.
 *
 * A fixed threshold suits one kind of market: in a busy one nearly every move counts as up or
 * down, in a dead one none does. Scaling keeps the question equally meaningful in both.
 * Rounded to 0.1 bp so the question's wording (and with it Jev's answer) does not change on
 * every call. `sigmas` = 0, or unknown volatility, gives the fixed thresholds in DIRECTIONS.
 */
export function flatThresholds(vol1sBps: number, sigmas: number): FlatThresholds {
  const scaled = sigmas > 0 && Number.isFinite(vol1sBps) && vol1sBps > 0;
  return Object.fromEntries(
    Object.entries(DIRECTIONS).map(([id, d]) => [id, scaled ? Math.max(0.1, Math.round(sigmas * vol1sBps * Math.sqrt(d.seconds) * 10) / 10) : d.flatBps]),
  ) as FlatThresholds;
}

export const directionQuestions = (flat: FlatThresholds) =>
  Object.fromEntries(Object.entries(DIRECTIONS).map(([id, d]) => [id, direction(d.seconds, flat[id as DirectionId])])) as Record<DirectionId, Question>;

export type Probabilities = Record<string, number>;
export type ModelResult = { probabilities: Record<DirectionId, Probabilities>; meta: CallMeta };

export async function decide(model: EvaluationModel, state: string, flat: FlatThresholds, abortSignal?: AbortSignal): Promise<ModelResult> {
  const result = await ask(model, state, directionQuestions(flat), abortSignal);
  const probabilities = Object.fromEntries(
    Object.entries(result.answers).map(([id, a]) => [id, a.type === 'choice' ? (a.probabilities ?? { [a.choice]: 1 }) : {}]),
  ) as ModelResult['probabilities'];
  return { probabilities, meta: result.meta };
}

/** P(up) - P(down): the directional signal extracted from a direction answer. */
export const directionSignal = (p: Probabilities) => (p.up ?? 0) - (p.down ?? 0);

// ---- mock -----------------------------------------------------------------------

function mockModel(latencyMs: number): EvaluationModel {
  const distribution = (n: number) => {
    const raw = Array.from({ length: n }, () => Math.random());
    const sum = raw.reduce((a, b) => a + b, 0);
    return raw.map(x => x / sum);
  };
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-jev',
    supportedQuestionTypes: ['choice', 'score', 'boolean'],
    async doEvaluate({ questions, abortSignal }) {
      const t0 = performance.now();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, latencyMs * (0.8 + 0.4 * Math.random()));
        abortSignal?.addEventListener('abort', () => (clearTimeout(timer), reject(abortSignal.reason)));
      });
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => {
          if (q.type === 'boolean') return [id, { type: 'boolean' as const, probability: Math.random() }];
          const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
          const p = distribution(keys.length);
          const probabilities = Object.fromEntries(keys.map((k, i) => [k, p[i]!]));
          if (q.type === 'score') return [id, { type: 'score' as const, score: p.reduce((s, x, i) => s + x * i, 0), probabilities }];
          return [id, { type: 'choice' as const, choice: keys[p.indexOf(Math.max(...p))]!, probabilities }];
        }),
      );
      return { answers, warnings: [], usage: { inputTokens: 0 }, response: { modelId: `mock-jev (${(performance.now() - t0).toFixed(0)}ms)` } };
    },
  };
}
