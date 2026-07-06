/**
 * Engine Beta score — private, experimental, per (player × category × game).
 *
 * NEVER a probability, edge, lock, pick, or recommendation. It exists only
 * to rank the admin's shortlist within a single category.
 *
 * Weights (sum to 100):
 *   40  Baseline strength   — z-score of baseline mean within category cohort
 *   25  Form alignment      — 14d recent rate delta in the favorable direction
 *   20  Opportunity         — confirmed lineup / role
 *   10  Freshness           — age of the underlying forecast run
 *    5  Uncertainty penalty — recent-form sample size confidence
 */

export type ScoreInputs = {
  higherIsBetter: boolean;
  baselineMean: number | null;
  /** Category cohort mean/stdev (across all eligible players for THIS category+role). */
  cohortMean: number | null;
  cohortStdev: number | null;
  /** Signed 14d rate delta (recent − season) in the model-relevant direction. */
  formDelta: number | null;
  /** "confirmed" | "projected" | "missing" for hitters; "confirmed" | "unconfirmed" for pitchers. */
  lineupState: string | null;
  /** ISO timestamp of forecast_runs.generated_at */
  forecastGeneratedAt: string | null;
  /** recent PA/BF denominator */
  recentDenominator: number | null;
};

export type ScoreComponents = {
  baseline: { raw: number | null; score: number; weight: number };
  form: { raw: number | null; score: number; weight: number };
  opportunity: { raw: string | null; score: number; weight: number };
  freshness: { raw: number | null; score: number; weight: number };
  uncertainty: { raw: number | null; score: number; weight: number };
  total: number;
};

const WEIGHTS = { baseline: 40, form: 25, opportunity: 20, freshness: 10, uncertainty: 5 };

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

function baselineScore(mean: number | null, cohortMean: number | null, cohortStdev: number | null, higherIsBetter: boolean): number {
  if (mean == null || cohortMean == null) return 0.5;
  const sd = cohortStdev && cohortStdev > 0 ? cohortStdev : Math.max(1e-6, Math.abs(cohortMean) * 0.25);
  const z = (mean - cohortMean) / sd;
  const signed = higherIsBetter ? z : -z;
  // Map z ∈ [-2, +2] → [0, 1]
  return clamp01(0.5 + signed / 4);
}

function formScore(delta: number | null, higherIsBetter: boolean): number {
  if (delta == null || !Number.isFinite(delta)) return 0.5;
  const signed = higherIsBetter ? delta : -delta;
  // Rates are per-PA; ±0.05 is a large move. Cap.
  return clamp01(0.5 + signed / 0.1);
}

function opportunityScore(state: string | null, role: "hitter" | "pitcher"): number {
  if (role === "hitter") {
    if (state === "confirmed" || state === "locked") return 1.0;
    if (state === "projected") return 0.6;
    return 0.2;
  }
  if (state === "confirmed" || state === "locked") return 1.0;
  return 0.5;
}

function freshnessScore(iso: string | null): number {
  if (!iso) return 0.3;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0.3;
  const hours = Math.max(0, (Date.now() - t) / 3_600_000);
  if (hours < 6) return 1.0;
  if (hours < 12) return 0.8;
  if (hours < 24) return 0.5;
  return 0.2;
}

function uncertaintyScore(denom: number | null): number {
  // Reward larger recent samples slightly; penalize very small ones.
  if (denom == null) return 0.3;
  if (denom >= 40) return 1.0;
  if (denom >= 20) return 0.75;
  if (denom >= 10) return 0.5;
  return 0.25;
}

export function computeEngineBetaScore(inp: ScoreInputs, role: "hitter" | "pitcher"): ScoreComponents {
  const b = baselineScore(inp.baselineMean, inp.cohortMean, inp.cohortStdev, inp.higherIsBetter);
  const f = formScore(inp.formDelta, inp.higherIsBetter);
  const o = opportunityScore(inp.lineupState, role);
  const fr = freshnessScore(inp.forecastGeneratedAt);
  const u = uncertaintyScore(inp.recentDenominator);
  const total = Math.round(b * WEIGHTS.baseline + f * WEIGHTS.form + o * WEIGHTS.opportunity + fr * WEIGHTS.freshness + u * WEIGHTS.uncertainty);
  return {
    baseline:    { raw: inp.baselineMean, score: +b.toFixed(3),  weight: WEIGHTS.baseline },
    form:        { raw: inp.formDelta,    score: +f.toFixed(3),  weight: WEIGHTS.form },
    opportunity: { raw: inp.lineupState,  score: +o.toFixed(3),  weight: WEIGHTS.opportunity },
    freshness:   { raw: inp.forecastGeneratedAt ? Math.round((Date.now() - Date.parse(inp.forecastGeneratedAt)) / 3_600_000) : null, score: +fr.toFixed(3), weight: WEIGHTS.freshness },
    uncertainty: { raw: inp.recentDenominator, score: +u.toFixed(3), weight: WEIGHTS.uncertainty },
    total,
  };
}

export const ENGINE_BETA_WEIGHTS = WEIGHTS;
