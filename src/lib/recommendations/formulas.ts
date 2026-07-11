/**
 * Pure math for Diamond recommendation scoring.
 *
 * No DB, no I/O. Unit-testable.
 *
 * Design notes:
 *  - Recommendation Score is a bounded 0..100 combination of probability edge
 *    (either sportsbook or calibrated-only), certainty (stability + sample),
 *    and small supporting features (form, matchup).
 *  - Probability and sportsbook edge remain the dominant drivers by weight.
 *  - Recent form is a supporting feature; matchup is a supporting feature;
 *    neither can push a play alone.
 *  - Uncertainty penalises high-variance projections.
 *  - This formula does NOT change the Diamond Score itself, and does NOT
 *    reuse Diamond Score components in a way that would double-count them.
 */

export const FORMULA_VERSION = "diamond-reco/v1.0.0" as const;

/** American odds → implied probability. */
export function americanToImplied(price: number): number | null {
  if (!Number.isFinite(price) || price === 0) return null;
  return price > 0 ? 100 / (price + 100) : -price / (-price + 100);
}

/**
 * Two-sided no-vig probability given both prices (both American).
 * Returns the fair probability of the FIRST side.
 */
export function twoSidedNoVig(sidePrice: number, oppPrice: number): number | null {
  const p = americanToImplied(sidePrice);
  const q = americanToImplied(oppPrice);
  if (p == null || q == null) return null;
  const total = p + q;
  if (total <= 0) return null;
  return p / total;
}

/** Expected value in profit units per 1 unit staked at price. */
export function expectedValue(modelProb: number, price: number): number | null {
  if (!Number.isFinite(modelProb) || modelProb < 0 || modelProb > 1) return null;
  const dec = decimalOdds(price);
  if (dec == null) return null;
  return modelProb * (dec - 1) - (1 - modelProb);
}

function decimalOdds(price: number): number | null {
  if (!Number.isFinite(price) || price === 0) return null;
  return price > 0 ? 1 + price / 100 : 1 + 100 / -price;
}

/** Bound value into a [0..1] range. */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export type RecommendationScoreInputs = {
  /** Model probability of the chosen side (0..1). */
  diamondProbability: number;
  /** No-vig implied probability of the chosen side (0..1) or null when market unavailable. */
  novigProbability: number | null;
  /** Sportsbook edge in probability points (diamond - novig), or null. */
  edgePp: number | null;
  /** Simulation stderr on the underlying mean (may be null). Lower is better. */
  stderr: number | null;
  /** Sim confidence (0..1) reported by the engine, if any. */
  confidence: number | null;
  /** Simulation count. */
  simCount: number;
  /** Recent-form direction: rising / stable / falling / null. */
  formDirection: "rising" | "stable" | "falling" | null;
  /** Reliability of the form signal (0..1). */
  formReliability: number | null;
  /** Matchup quality (0..1) — 0.5 neutral. Null if unsupported. */
  matchupQuality: number | null;
};

/** Component breakdown (each 0..1) so the UI can show why. */
export type RecommendationScoreBreakdown = {
  probability: number;
  edge: number;
  certainty: number;
  form: number;
  matchup: number;
};

/**
 * Compute a bounded 0..100 recommendation score plus the component
 * breakdown that the "Why Diamond likes it" panel renders.
 *
 * Weights (probability + edge = 0.72 of total):
 *   - probability  : 0.32
 *   - edge         : 0.40 (when real market edge exists — 0 otherwise)
 *   - certainty    : 0.14
 *   - form         : 0.08
 *   - matchup      : 0.06
 *
 * When edge is unavailable, its weight (0.40) is re-allocated to the
 * probability component (probability weight becomes 0.72) so probability-
 * only plays remain rankable but strictly separated from edge plays by
 * caller-side tiering.
 */
export function scoreRecommendation(i: RecommendationScoreInputs): {
  score: number;
  breakdown: RecommendationScoreBreakdown;
  probabilityOnly: boolean;
} {
  const prob = clamp01(i.diamondProbability);

  // Edge subscore: map edge in pp to 0..1 (saturating at +12pp).
  let edgeSub = 0;
  let hasEdge = false;
  if (i.edgePp != null && Number.isFinite(i.edgePp)) {
    hasEdge = true;
    edgeSub = clamp01(i.edgePp / 12);
  }

  // Certainty: combine sim count, confidence, and stderr into 0..1.
  const simSat = clamp01(Math.log10(Math.max(1, i.simCount)) / 4); // saturates at 10k sims
  const conf = clamp01(i.confidence ?? 0.5);
  const stderrPenalty = i.stderr != null && Number.isFinite(i.stderr)
    ? clamp01(1 - Math.min(1, i.stderr))
    : 0.5;
  const certainty = clamp01(0.4 * simSat + 0.35 * conf + 0.25 * stderrPenalty);

  // Form subscore (only rising raises the score above neutral).
  const formReliability = clamp01(i.formReliability ?? 0);
  const formDir = i.formDirection === "rising"
    ? 1
    : i.formDirection === "falling"
      ? 0
      : 0.5;
  const form = clamp01(0.5 + (formDir - 0.5) * formReliability);

  // Matchup: 0.5 when unavailable — neutral, does not push.
  const matchup = clamp01(i.matchupQuality ?? 0.5);

  const wProb = hasEdge ? 0.32 : 0.72;
  const wEdge = hasEdge ? 0.40 : 0.0;
  const wCert = 0.14;
  const wForm = 0.08;
  const wMatch = 0.06;

  const raw =
    wProb * prob +
    wEdge * edgeSub +
    wCert * certainty +
    wForm * form +
    wMatch * matchup;

  return {
    score: Math.round(raw * 1000) / 10, // 0..100 with one decimal
    breakdown: {
      probability: Math.round(prob * 1000) / 1000,
      edge: hasEdge ? Math.round(edgeSub * 1000) / 1000 : 0,
      certainty: Math.round(certainty * 1000) / 1000,
      form: Math.round(form * 1000) / 1000,
      matchup: Math.round(matchup * 1000) / 1000,
    },
    probabilityOnly: !hasEdge,
  };
}

/**
 * Estimated combined probability for a cross-game ticket:
 * assumes leg independence — legitimate ONLY because the ticket builder
 * rejects same-game and correlated legs.
 */
export function estimatedCombinedProbability(legProbs: number[]): number | null {
  if (!legProbs.length) return null;
  let p = 1;
  for (const q of legProbs) {
    if (!Number.isFinite(q) || q < 0 || q > 1) return null;
    p *= q;
  }
  return p;
}
