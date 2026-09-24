// Stand-ins for the outside world, so engine tests need no network, no waiting, and no luck.

import type { Experimental_EvaluationModel as EvaluationModel } from 'ai';
import type { Prices } from '../src/market/prices.ts';

export type Step = 'ok' | 'rate-limit' | 'server-error' | 'bad-request' | 'out-of-credits';

/**
 * A model that answers the same way every time, after playing out a script of failures.
 * `route` picks which of the two real routes it imitates, because they report different things
 * about a call: the gateway its own cost and timing, TypeSafe its build and service time.
 */
export function scriptedModel(script: Step[] = [], route: 'gateway' | 'typesafe' = 'gateway') {
  const calls: { state: unknown; questions: Record<string, { type: string; instructions: string }> }[] = [];
  const model: EvaluationModel = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted',
    supportedQuestionTypes: ['choice', 'score', 'boolean'],
    async doEvaluate({ state, questions }) {
      calls.push({ state, questions: questions as never });
      const step = script.shift() ?? 'ok';
      if (step === 'rate-limit') throw Object.assign(new Error('rate limited'), { statusCode: 429 });
      if (step === 'server-error') throw Object.assign(new Error('upstream timed out'), { statusCode: 504 });
      if (step === 'bad-request') throw Object.assign(new Error('bad request'), { statusCode: 400 });
      // What TypeSafe said for 27 hours on the Pi (2026-09-22 to 23).
      if (step === 'out-of-credits') throw new Error('{"error_type":"billing_error","message":"Your organization has no available TypeSafe API credits."}');
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => {
          if (q.type === 'boolean') return [id, { type: 'boolean' as const, probability: 0.9 }];
          if (q.type === 'score') return [id, { type: 'score' as const, score: 2, probabilities: { '0': 0, '1': 0.25, '2': 0.5, '3': 0.25 } }];
          // First option 0.8, the others 0.1 each (news: bullish/bearish/neutral; market data: up/down/flat).
          const keys = Object.keys(q.criteria);
          return [id, { type: 'choice' as const, choice: keys[0]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.8 : 0.1])) }];
        }),
      );
      const confidence = { direction_0: 0.75, magnitude_0: 0.5 };
      // The gateway prices and times the call from outside and echoes the route it was asked
      // for; TypeSafe reports its own service time in a header and names the build that answered.
      const asGateway = route === 'gateway';
      return {
        answers,
        warnings: [],
        usage: { inputTokens: 600, ...(asGateway ? {} : { outputTokens: 42 }) },
        providerMetadata: {
          typesafe: { confidence },
          ...(asGateway ? { gateway: { marketCost: '0.000025', routing: { modelAttempts: [{ providerAttempts: [{ startTime: 1000, endTime: 1120 }] }] } } } : {}),
        },
        response: asGateway ? { modelId: 'typesafe-ai/jev' } : { modelId: 'jev-1.13.0', headers: { 'x-envoy-upstream-service-time': '90' } },
      };
    },
  };
  return { model, calls };
}

type Quote = { mid: number; spreadBps: number; lastClose?: number; tracked?: boolean };

/** Prices that are whatever the test says, and that move by `driftPerMs` so forward prices differ. */
export class FakePrices implements Prices {
  prepared: string[][] = [];
  quotes = new Map<string, Quote>();
  driftPerMs = 0;
  t0 = 0;

  set(symbol: string, q: Quote) {
    this.quotes.set(symbol, q);
    return this;
  }
  async prepare(symbols: string[]) {
    this.prepared.push(symbols);
    return new Set(symbols.filter(s => this.quotes.get(s)?.tracked !== false));
  }
  mid(symbol: string) {
    return this.quotes.get(symbol)?.mid ?? NaN;
  }
  midAt(symbol: string, t: number) {
    const q = this.quotes.get(symbol);
    return q ? q.mid + (t - this.t0) * this.driftPerMs : NaN;
  }
  spreadBps(symbol: string) {
    return this.quotes.get(symbol)?.spreadBps ?? NaN;
  }
  spreadAt(symbol: string) {
    return this.spreadBps(symbol);
  }
  lastClose(symbol: string) {
    return this.quotes.get(symbol)?.lastClose ?? NaN;
  }
  tick() {}
}

/** Let pending promises and microtasks run. */
export async function settle() {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}
