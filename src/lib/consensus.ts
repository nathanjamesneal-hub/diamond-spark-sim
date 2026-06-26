/**
 * Diamond Consensus — display-only helpers.
 *
 * Builds a "agreement score" by combining existing model outputs:
 *   - Diamond Score (model conviction)
 *   - Monte Carlo Sim Mean (expected outcome)
 *   - Monte Carlo Sim Probability (threshold/event likelihood)
 *   - Confidence / lineup-status factor
 *
 * Rules:
 *   - Percentile ranks are computed strictly WITHIN the same category + slate.
 *   - No new projections, no probability synthesis, no engine math.
 *   - This module never writes back to projections or snapshots.
 */

export type LineupStatus = "locked" | "verified" | "waiting" | null | undefined;

/**
 * Rank-based percentile within an array of numeric values (0–100).
 * Null/NaN values are excluded from the population. A value of `null` returns null.
 * Ties are handled with average-rank percentile.
 */
export function categoryPercentile(
  population: ReadonlyArray<number | null | undefined>,
  value: number | null | undefined,
): number | null {
  if (value == null || !isFinite(value)) return null;
  const xs = population.filter((v): v is number => v != null && isFinite(v));
  if (xs.length === 0) return null;
  if (xs.length === 1) return 50;
  let below = 0;
  let equal = 0;
  for (const v of xs) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  // average-rank percentile
  const pct = ((below + 0.5 * equal) / xs.length) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Lineup-status factor used as a modest 0..1 ranking modifier. */
export function lineupFactor(status: LineupStatus): number {
  switch (status) {
    case "locked":
      return 1.0;
    case "verified":
      return 0.85;
    case "waiting":
      return 0.6;
    default:
      return 0.5; // missing → neutral, never inflate
  }
}

/**
 * Confidence (0..100 from the engine) → 0..1 factor used as a small modifier.
 * Missing confidence falls back to a neutral 0.5 (never inflates ranking).
 */
export function confidenceFactor(confidence: number | null | undefined): number {
  if (confidence == null || !isFinite(confidence)) return 0.5;
  const c = confidence > 1 ? confidence / 100 : confidence;
  return Math.max(0, Math.min(1, c));
}

export type ConsensusInputs = {
  dsPct: number | null;      // Diamond Score percentile within category
  meanPct: number | null;    // Sim Mean percentile within category
  probPct: number | null;    // Sim Probability percentile within category (null if no real prob)
  confidence01: number;      // 0..1 (already blended of confidence + lineup factor)
};

export type ConsensusBreakdown = {
  consensusScore: number;          // 0..100
  weights: { ds: number; mean: number; prob: number; confidence: number };
  contributions: { ds: number; mean: number; prob: number; confidence: number };
  probAvailable: boolean;
};

/**
 * Display-only consensus score. Returns null only if every signal is missing.
 *   Base weights: DS 40 · Mean 30 · Prob 20 · Confidence 10
 *   If probability is unavailable, redistribute the 20% to DS and Mean
 *   proportionally (8/12 → DS +13.33, Mean +6.67 → DS 53.33 · Mean 36.67 · Conf 10).
 */
export function consensusScore(input: ConsensusInputs): ConsensusBreakdown | null {
  const { dsPct, meanPct, probPct, confidence01 } = input;
  if (dsPct == null && meanPct == null && probPct == null) return null;

  const hasProb = probPct != null;
  const weights = hasProb
    ? { ds: 0.40, mean: 0.30, prob: 0.20, confidence: 0.10 }
    : { ds: 0.40 + 0.20 * (8 / 12), mean: 0.30 + 0.20 * (4 / 12), prob: 0, confidence: 0.10 };

  const ds = dsPct ?? 0;
  const mean = meanPct ?? 0;
  const prob = probPct ?? 0;
  const conf = confidence01 * 100;

  const contributions = {
    ds: ds * weights.ds,
    mean: mean * weights.mean,
    prob: prob * weights.prob,
    confidence: conf * weights.confidence,
  };
  const consensus =
    contributions.ds + contributions.mean + contributions.prob + contributions.confidence;

  return {
    consensusScore: Math.max(0, Math.min(100, consensus)),
    weights,
    contributions,
    probAvailable: hasProb,
  };
}

export type AlignmentLabel =
  | "Full Alignment"
  | "Strong Alignment"
  | "Simulation-Led"
  | "Diamond-Led"
  | "Needs Context";

/**
 * Display-only label based on percentile agreement.
 * High = >= 75, Mid = >= 55, Low = < 55.
 */
export function alignmentLabel(args: {
  dsPct: number | null;
  meanPct: number | null;
  probPct: number | null;
  lineupStatus: LineupStatus;
}): AlignmentLabel {
  const { dsPct, meanPct, probPct, lineupStatus } = args;
  const high = (p: number | null) => p != null && p >= 75;
  const mid = (p: number | null) => p != null && p >= 55;
  const confirmed = lineupStatus === "locked" || lineupStatus === "verified";

  if (high(dsPct) && high(meanPct) && high(probPct) && confirmed) return "Full Alignment";

  const strongSignals = [high(dsPct), high(meanPct), high(probPct)].filter(Boolean).length;
  if (strongSignals >= 2) return "Strong Alignment";

  if ((high(meanPct) || high(probPct)) && !mid(dsPct)) return "Simulation-Led";
  if (high(dsPct) && !mid(meanPct) && !mid(probPct)) return "Diamond-Led";

  return "Needs Context";
}

export function alignmentTone(label: AlignmentLabel): "strong" | "good" | "warn" | "muted" {
  switch (label) {
    case "Full Alignment":
      return "strong";
    case "Strong Alignment":
      return "good";
    case "Simulation-Led":
    case "Diamond-Led":
      return "warn";
    default:
      return "muted";
  }
}
