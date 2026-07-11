/**
 * Prop Board scoring — Phase A (LIVE mode).
 *
 * Pure, deterministic functions. No I/O. No fabrication.
 *
 * Inputs come from persisted sim_player_outputs (projected_mean,
 * event_probability, sim_count, stderr, confidence, form_*, engine_status,
 * projection_stage, threshold) plus optional matchup_grade from projections
 * and lineup_status from game_lineup_status.
 *
 * Ranking primacy: Monte Carlo threshold probability is the strongest driver
 * (>= 55% of the composite in model-only mode, >= 35% in market-compared
 * mode). Recent form is a small support/decay signal (<=8%) and cannot
 * promote a weak-probability play. Missing matchup data does NOT get a
 * neutral placeholder — its weight is proportionally redistributed to
 * probability, mean-vs-line, and opportunity.
 */

export type PropMarket =
  | "1plus_hit"
  | "2plus_hits"
  | "total_bases"
  | "hr"
  | "k"
  | "outs"
  | "er";

export const SUPPORTED_MARKETS: readonly PropMarket[] = [
  "1plus_hit",
  "2plus_hits",
  "total_bases",
  "hr",
  "k",
  "outs",
  "er",
] as const;

export const MARKET_META: Record<
  PropMarket,
  { label: string; line: string; role: "hitter" | "pitcher"; unit: string }
> = {
  "1plus_hit":  { label: "1+ Hit",        line: "1+ H",   role: "hitter",  unit: "H" },
  "2plus_hits": { label: "2+ Hits",       line: "2+ H",   role: "hitter",  unit: "H" },
  total_bases:  { label: "Total Bases",   line: "2+ TB",  role: "hitter",  unit: "TB" },
  hr:           { label: "Home Run",      line: "1+ HR",  role: "hitter",  unit: "HR" },
  k:            { label: "Strikeouts",    line: "5.5+ K", role: "pitcher", unit: "K" },
  outs:         { label: "Outs Recorded", line: "15.5+",  role: "pitcher", unit: "Outs" },
  er:           { label: "Earned Runs",   line: "2.5+",   role: "pitcher", unit: "ER" },
};

/** Market-specific probability thresholds (probability of clearing line). */
export const MARKET_PROB_THRESHOLDS: Record<
  PropMarket,
  { heavy: number; strong: number; watchlist: number }
> = {
  "1plus_hit":  { heavy: 0.80, strong: 0.68, watchlist: 0.55 },
  "2plus_hits": { heavy: 0.42, strong: 0.32, watchlist: 0.24 },
  total_bases:  { heavy: 0.60, strong: 0.48, watchlist: 0.38 },
  hr:           { heavy: 0.22, strong: 0.15, watchlist: 0.10 },
  k:            { heavy: 0.65, strong: 0.52, watchlist: 0.40 },
  outs:         { heavy: 0.62, strong: 0.50, watchlist: 0.40 },
  er:           { heavy: 0.60, strong: 0.48, watchlist: 0.38 }, // "under 2.5+ ER" reasoning left to consumer
};

export type FormDirection = "rising" | "stable" | "falling" | "unknown";

export interface ScoreInputs {
  market: PropMarket;
  /** Persisted probability of clearing threshold (0..1). REQUIRED. */
  eventProbability: number | null;
  /** Persisted Monte Carlo mean. REQUIRED. */
  projectedMean: number | null;
  /** Line the sim ran against (for mean-vs-line ratio). Can be null for pure count markets. */
  threshold: number | null;
  /** Sim iterations. */
  simCount: number | null;
  /** Standard error of the mean. */
  stderr: number | null;
  /** 0..1 engine confidence. */
  confidence: number | null;
  /** Recent-form direction from sim inputs. */
  formDirection: FormDirection | null;
  /** Prob adjustment applied by recent form (-1..1 scale, typically -0.1..0.1). */
  formProbAdjustment: number | null;
  /** How many recent games informed the adjustment. */
  formSampleSize: number | null;
  /** 0..1 reliability of the form signal. */
  formReliability: number | null;
  /** 0..100 matchup grade from projections. null = matchup data unavailable. */
  matchupGrade: number | null;
  /** "confirmed" | "expected" | "projected" | "unknown". Drives opportunity certainty. */
  lineupStatus: "confirmed" | "expected" | "projected" | "unknown";
  /** Projection stage from sim output. */
  projectionStage: string | null;
  /** Whether a newer sim job is pending for this player/market. */
  newerSimPending: boolean;
  /** How stale the sim output is, in minutes. */
  ageMinutes: number;
  /** Engine status from the sim output. scaffold_unvalidated flags Preview tier. */
  engineStatus: string | null;
  /** Sportsbook price present? (v1: not connected — always false). */
  hasMarketPrice: boolean;
  /** Vig-free implied market probability (0..1) when a real book price exists. */
  noVigMarketProb: number | null;
}

export type ConfidenceTier = "heavy" | "strong" | "watchlist" | "excluded" | "preview";

export interface ScoreOutput {
  /** 0..100 composite prop-quality score, normalized within market by caller. */
  score: number;
  /** Raw 0..1 components (transparent audit trail). */
  components: {
    probability: number;
    meanVsLine: number;
    opportunity: number;
    form: number;
    matchup: number | null; // null when matchup data unavailable
    stability: number;
    marketEdge: number | null; // null in model-only mode
  };
  /** Weights actually applied (after matchup redistribution when unavailable). */
  weightsApplied: {
    probability: number;
    meanVsLine: number;
    opportunity: number;
    form: number;
    matchup: number; // 0 when unavailable
    stability: number;
    marketEdge: number; // 0 in model-only mode
  };
  mode: "model_only" | "market_compared";
  tier: ConfidenceTier;
  /** Machine-readable reason codes (also drives Watchlist warnings). */
  reasons: string[];
  /** True when this row should NOT feed tickets or Best-of. */
  excluded: boolean;
}

const clamp01 = (n: number): number => (isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

function meanVsLineComponent(mean: number | null, threshold: number | null, market: PropMarket): number {
  if (mean == null || !isFinite(mean)) return 0;
  // For pure count-1+ markets threshold is often null; use 1 as implicit line.
  const line =
    threshold != null && isFinite(threshold) && threshold > 0
      ? threshold
      : market === "1plus_hit" || market === "hr" || market === "2plus_hits"
      ? market === "2plus_hits"
        ? 1.5
        : 0.5
      : null;
  if (line == null) return 0;
  // For "under" markets (er) treat lower mean as better.
  if (market === "er") {
    // Score peaks when mean is well below line.
    const ratio = mean / line;
    return clamp01(1 - Math.max(0, ratio - 0.4)); // mean=0.4*line → 1.0, mean=line → 0.4
  }
  const ratio = mean / line;
  return clamp01((ratio - 0.5) / 1.5); // ratio=0.5→0, ratio=2.0→1
}

function opportunityComponent(lineupStatus: ScoreInputs["lineupStatus"]): number {
  switch (lineupStatus) {
    case "confirmed":
      return 1.0;
    case "expected":
      return 0.75;
    case "projected":
      return 0.55;
    default:
      return 0.35;
  }
}

function formComponent(inp: ScoreInputs): number {
  const dir = inp.formDirection ?? "unknown";
  const rel = clamp01(inp.formReliability ?? 0);
  const n = Math.max(0, inp.formSampleSize ?? 0);
  const sampleWeight = clamp01(n / 15); // full weight at ~15 games
  const dirScore = dir === "rising" ? 0.75 : dir === "stable" ? 0.55 : dir === "falling" ? 0.3 : 0.5;
  // Regress toward baseline (0.5) by combined reliability * sample.
  const w = rel * sampleWeight;
  return clamp01(0.5 * (1 - w) + dirScore * w);
}

function matchupComponent(grade: number | null): number | null {
  if (grade == null || !isFinite(grade)) return null;
  return clamp01(grade / 100);
}

function stabilityComponent(inp: ScoreInputs): number {
  const simN = inp.simCount ?? 0;
  const nScore = clamp01(Math.log10(Math.max(1, simN)) / 4); // 10k sims → 1.0
  const conf = clamp01(inp.confidence ?? 0.5);
  const mean = inp.projectedMean ?? 0;
  const stderrScore =
    inp.stderr != null && mean > 0
      ? clamp01(1 - Math.min(1, inp.stderr / Math.max(0.1, mean)))
      : 0.5;
  return clamp01(0.4 * nScore + 0.35 * stderrScore + 0.25 * conf);
}

function marketEdgeComponent(prob: number | null, noVig: number | null): number | null {
  if (prob == null || noVig == null) return null;
  // Edge normalized: +10pp -> 1.0, 0 -> 0.5, -10pp -> 0.
  const edge = prob - noVig;
  return clamp01(0.5 + edge * 5);
}

const WEIGHTS_MODEL = {
  probability: 0.55,
  meanVsLine: 0.17,
  opportunity: 0.12,
  form: 0.08,
  matchup: 0.05,
  stability: 0.03,
  marketEdge: 0,
} as const;

const WEIGHTS_MARKET = {
  probability: 0.35,
  meanVsLine: 0.12,
  opportunity: 0.10,
  form: 0.08,
  matchup: 0.06,
  stability: 0.04,
  marketEdge: 0.25,
} as const;

export function scoreCandidate(inp: ScoreInputs): ScoreOutput {
  const reasons: string[] = [];
  let excluded = false;

  // Hard exclusions first — order matters for reason codes.
  if (inp.eventProbability == null || !isFinite(inp.eventProbability)) {
    reasons.push("missing_probability");
    excluded = true;
  }
  if (inp.projectedMean == null || !isFinite(inp.projectedMean) || inp.projectedMean <= 0) {
    reasons.push("missing_mean");
    excluded = true;
  }
  if ((inp.simCount ?? 0) < 500) reasons.push("low_sim_count");
  if ((inp.simCount ?? 0) < 100) excluded = true;
  if (inp.newerSimPending) {
    reasons.push("newer_sim_pending");
    excluded = true;
  }
  if (inp.ageMinutes > 240) {
    reasons.push("stale_output");
    excluded = true;
  } else if (inp.ageMinutes > 90) {
    reasons.push("aging_output");
  }

  const mode: ScoreOutput["mode"] = inp.hasMarketPrice && inp.noVigMarketProb != null ? "market_compared" : "model_only";
  const baseWeights = mode === "market_compared" ? WEIGHTS_MARKET : WEIGHTS_MODEL;

  const components = {
    probability: clamp01(inp.eventProbability ?? 0),
    meanVsLine: meanVsLineComponent(inp.projectedMean, inp.threshold, inp.market),
    opportunity: opportunityComponent(inp.lineupStatus),
    form: formComponent(inp),
    matchup: matchupComponent(inp.matchupGrade),
    stability: stabilityComponent(inp),
    marketEdge: marketEdgeComponent(inp.eventProbability, inp.noVigMarketProb),
  };

  // Redistribute matchup weight when unavailable — proportionally to
  // probability, meanVsLine, and opportunity (the three signals the spec
  // names).  Do NOT synthesize a neutral matchup value.
  const weightsApplied = { ...baseWeights } as {
    probability: number;
    meanVsLine: number;
    opportunity: number;
    form: number;
    matchup: number;
    stability: number;
    marketEdge: number;
  };
  if (components.matchup == null) {
    reasons.push("matchup_unavailable");
    const w = baseWeights.matchup;
    const denom = baseWeights.probability + baseWeights.meanVsLine + baseWeights.opportunity;
    weightsApplied.matchup = 0;
    weightsApplied.probability += (w * baseWeights.probability) / denom;
    weightsApplied.meanVsLine += (w * baseWeights.meanVsLine) / denom;
    weightsApplied.opportunity += (w * baseWeights.opportunity) / denom;
  }
  if (mode === "model_only") {
    reasons.push("model_only_no_price");
    weightsApplied.marketEdge = 0;
  }

  // Watchlist / warning reasons (non-excluding).
  if (inp.lineupStatus === "projected") reasons.push("projected_lineup");
  if (inp.lineupStatus === "unknown") reasons.push("lineup_unknown");
  if (inp.matchupGrade == null) {
    /* already added */
  }
  if ((inp.stderr ?? 0) > (inp.projectedMean ?? 0) * 0.4) reasons.push("high_uncertainty");
  if (inp.formDirection === "falling" && (inp.formReliability ?? 0) > 0.5) reasons.push("negative_recent_form");
  if ((inp.formSampleSize ?? 0) < 5 && (inp.formSampleSize ?? 0) > 0) reasons.push("small_form_sample");

  const esNorm = (inp.engineStatus ?? "").toLowerCase();
  const isPreview = esNorm === "scaffold_unvalidated" || esNorm === "diamond_mc_candidate";
  if (isPreview) reasons.push(esNorm === "diamond_mc_candidate" ? "preview_diamond_mc_candidate" : "preview_engine_unvalidated");

  const rawScore =
    weightsApplied.probability * components.probability +
    weightsApplied.meanVsLine * components.meanVsLine +
    weightsApplied.opportunity * components.opportunity +
    weightsApplied.form * components.form +
    weightsApplied.matchup * (components.matchup ?? 0) +
    weightsApplied.stability * components.stability +
    weightsApplied.marketEdge * (components.marketEdge ?? 0);

  const score = clamp01(rawScore) * 100;

  // Tier assignment.
  let tier: ConfidenceTier;
  if (excluded) {
    tier = "excluded";
  } else if (isPreview) {
    tier = "preview";
  } else {
    const t = MARKET_PROB_THRESHOLDS[inp.market];
    const p = components.probability;
    const hasMaterialConcern =
      inp.lineupStatus === "projected" ||
      inp.lineupStatus === "unknown" ||
      components.matchup == null ||
      reasons.includes("high_uncertainty") ||
      reasons.includes("aging_output") ||
      reasons.includes("small_form_sample");

    if (p >= t.heavy && score >= 62 && !hasMaterialConcern) tier = "heavy";
    else if (p >= t.strong && score >= 48) tier = "strong";
    else if (p >= t.watchlist) tier = "watchlist";
    else {
      tier = "excluded";
      reasons.push("below_watchlist_probability");
      excluded = true;
    }
  }

  return { score, components, weightsApplied, mode, tier, reasons, excluded };
}

/** Normalize scores within a market to 0..100 relative rank score. */
export function normalizeWithinMarket<T extends { score: number }>(rows: T[]): T[] {
  if (rows.length === 0) return rows;
  const max = Math.max(...rows.map((r) => r.score), 1);
  return rows.map((r) => ({ ...r, score: (r.score / max) * 100 }));
}
