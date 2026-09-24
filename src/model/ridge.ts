// The order-book model: a linear fit, from research/fit.py, of the move over the next 10 or 60
// seconds on six measurements of the book (MarketState's features and bookShape in
// src/market/microstructure.ts).
//
// It runs locally, in microseconds, with no call to anyone, so unlike Jev it costs nothing and
// never waits on a network. Its answer is the expected mid move in basis points, which is what
// deciding whether a trade can pay for itself needs: a direction alone cannot be set against a
// fee. At 10 s that expectation proved well calibrated on days the fit never saw; at 60 s the
// model found nothing, and is kept so its live record keeps testing that (docs/accuracy.md).
//
// The weights live in src/model/weights/, committed, so the Pi runs exactly what was tested.

import { existsSync, readdirSync, readFileSync } from 'node:fs';

export type RidgeModel = {
  kind: 'ridge';
  horizonS: number;
  features: string[];
  /** Each input is clipped to [lo, hi], then standardized with mean and sd, as in the fit. */
  lo: number[];
  hi: number[];
  mean: number[];
  sd: number[];
  weights: number[];
  intercept: number;
  /** |prediction| above which a call was in the strongest share of calls in training, by share. */
  strongCut: Record<string, number>;
  /**
   * Where the model was most often right: a quiet minute and a one-tick spread. `gate` says
   * whether trading on it should wait for that (it helped at 10 s and not at 60 s).
   */
  calm: { gate: boolean; vol60Below: number; maxSpreadTicks: number; tickUsd: number };
  trainedOn: string[];
  testedOn: string;
  entryMs: number;
  /** A few rows with the answer the fit gave them, so a test can check this code agrees. */
  examples: { inputs: Record<string, number | null>; expected: number }[];
};

export function loadRidge(path: string | URL): RidgeModel {
  const m = JSON.parse(readFileSync(path, 'utf8')) as RidgeModel;
  const n = m.features.length;
  if (m.kind !== 'ridge' || [m.lo, m.hi, m.mean, m.sd, m.weights].some(a => a.length !== n)) throw new Error(`${String(path)} is not a ridge model`);
  return m;
}

/** Every model in a folder of `ridge-<seconds>s.json` files, shortest horizon first. */
export function loadAll(dir: URL): RidgeModel[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^ridge-\d+s\.json$/.test(f))
    .map(f => loadRidge(new URL(f, dir)))
    .sort((a, b) => a.horizonS - b.horizonS);
}

/** The models the live engine and backtests use. */
export const orderBookModels: RidgeModel[] = loadAll(new URL('./weights/', import.meta.url));

/** Expected move in bps. A measurement that is missing or not a number counts as its training average, exactly as in the fit. */
export function predict(m: RidgeModel, values: Record<string, unknown>): number {
  let y = m.intercept;
  for (let i = 0; i < m.features.length; i++) {
    const v = values[m.features[i]!];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const z = (Math.min(Math.max(v, m.lo[i]!), m.hi[i]!) - m.mean[i]!) / m.sd[i]!;
    y += z * m.weights[i]!;
  }
  return y;
}

/** The expected move for every horizon there is a model for, as `ob_<seconds>s`. */
export function orderBookSignals(values: Record<string, unknown>, models: readonly RidgeModel[] = orderBookModels): Record<string, number> {
  return Object.fromEntries(models.map(m => [`ob_${m.horizonS}s`, predict(m, values)]));
}

/**
 * Whether the market is as calm as the model needs before its calls are traded. Always true for
 * a model with no such condition. Unknown volatility or spread counts as not calm.
 */
export function calmEnough(m: RidgeModel, vol60: number | undefined, spreadUsd: number | undefined): boolean {
  if (!m.calm.gate) return true;
  if (typeof vol60 !== 'number' || typeof spreadUsd !== 'number' || !Number.isFinite(vol60) || !Number.isFinite(spreadUsd)) return false;
  return vol60 < m.calm.vol60Below && spreadUsd < (m.calm.maxSpreadTicks + 0.5) * m.calm.tickUsd;
}
