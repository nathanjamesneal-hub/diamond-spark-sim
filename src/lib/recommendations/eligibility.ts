/**
 * Pure leg-eligibility checks for the recommendation builder.
 *
 * Every gate returns either { ok: true } or { ok: false, reason }.
 * Reasons are STABLE codes — the UI shows them verbatim to explain
 * why a candidate was rejected.
 */

export type EligibilityReason =
  | "projection_missing"
  | "projection_stale"
  | "engine_not_validated"
  | "sim_count_too_low"
  | "uncertainty_too_high"
  | "player_not_in_lineup"
  | "game_started"
  | "newer_sim_pending"
  | "market_unsupported"
  | "no_market_price"
  | "probability_below_threshold"
  | "score_below_threshold"
  | "no_positive_edge"
  | "duplicate_player"
  | "same_game_conflict";

export const RECOMMENDATION_THRESHOLDS = {
  MIN_PROBABILITY: 0.55,
  MIN_SCORE: 58,
  MIN_SIM_COUNT: 500,
  MAX_STDERR: 0.9,
  BEST_BET_MIN_SCORE: 74,
  BEST_BET_MIN_PROB: 0.6,
  TICKET_MIN_LEG_PROB: 0.58,
  TICKET_MIN_LEG_SCORE: 62,
  HIGHER_UPSIDE_MIN_LEG_PROB: 0.52,
  HIGHER_UPSIDE_MIN_LEG_SCORE: 55,
} as const;

export type LegCandidateInput = {
  runStatus: string | null;
  engineStatus: string | null;
  simCount: number | null;
  stderr: number | null;
  projectionStage: string | null;
  projectionCompletedAt: string | null;
  playerInLineup: boolean;
  isStartingPitcher: boolean;
  gameStarted: boolean;
  newerSimPending: boolean;
  supportedMarket: boolean;
  hasMarketPrice: boolean;
  diamondProbability: number | null;
  edgePp: number | null;
  score: number | null;
  requiresMarketEdge: boolean;
};

export type EligibilityResult = { ok: true } | { ok: false; reason: EligibilityReason };

/** Validated engine statuses — anything else is quarantined to preview. */
export function isValidatedEngineStatus(s: string | null | undefined): boolean {
  if (!s) return false;
  return s === "validated" || s === "validated_pregame" || s === "production";
}

export function checkLegEligibility(x: LegCandidateInput): EligibilityResult {
  if (!x.runStatus || x.runStatus !== "completed") return { ok: false, reason: "projection_missing" };
  if (!isValidatedEngineStatus(x.engineStatus)) return { ok: false, reason: "engine_not_validated" };
  if ((x.simCount ?? 0) < RECOMMENDATION_THRESHOLDS.MIN_SIM_COUNT) return { ok: false, reason: "sim_count_too_low" };
  if (x.stderr != null && x.stderr > RECOMMENDATION_THRESHOLDS.MAX_STDERR) return { ok: false, reason: "uncertainty_too_high" };
  if (!x.playerInLineup && !x.isStartingPitcher) return { ok: false, reason: "player_not_in_lineup" };
  if (x.gameStarted) return { ok: false, reason: "game_started" };
  if (x.newerSimPending) return { ok: false, reason: "newer_sim_pending" };
  if (!x.supportedMarket) return { ok: false, reason: "market_unsupported" };
  if (x.requiresMarketEdge && !x.hasMarketPrice) return { ok: false, reason: "no_market_price" };
  if ((x.diamondProbability ?? 0) < RECOMMENDATION_THRESHOLDS.MIN_PROBABILITY) return { ok: false, reason: "probability_below_threshold" };
  if (x.requiresMarketEdge && x.edgePp != null && x.edgePp <= 0) return { ok: false, reason: "no_positive_edge" };
  if ((x.score ?? 0) < RECOMMENDATION_THRESHOLDS.MIN_SCORE) return { ok: false, reason: "score_below_threshold" };
  return { ok: true };
}

/** Filter selected legs into a Best Bet + up to N featured. */
export function pickBestBetAndFeatured<T extends { score: number; probability: number }>(
  eligible: T[],
  maxFeatured: number = 5,
): { bestBet: T | null; featured: T[] } {
  const sorted = [...eligible].sort((a, b) => b.score - a.score);
  const bestBet =
    sorted.length > 0 &&
    sorted[0].score >= RECOMMENDATION_THRESHOLDS.BEST_BET_MIN_SCORE &&
    sorted[0].probability >= RECOMMENDATION_THRESHOLDS.BEST_BET_MIN_PROB
      ? sorted[0]
      : null;
  const featured = sorted.slice(bestBet ? 1 : 0, (bestBet ? 1 : 0) + maxFeatured);
  return { bestBet, featured };
}

/**
 * Assemble cross-game tickets — one leg per player, one leg per game,
 * threshold-gated. Higher-upside relaxes leg probability but never below
 * HIGHER_UPSIDE_MIN_LEG_PROB.
 */
export function assembleTicket<T extends {
  playerId: string;
  gameId: string;
  probability: number;
  score: number;
}>(
  eligible: T[],
  size: number,
  opts?: { minProb?: number; minScore?: number },
): T[] | null {
  const minProb = opts?.minProb ?? RECOMMENDATION_THRESHOLDS.TICKET_MIN_LEG_PROB;
  const minScore = opts?.minScore ?? RECOMMENDATION_THRESHOLDS.TICKET_MIN_LEG_SCORE;
  const pool = eligible
    .filter((l) => l.probability >= minProb && l.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const picked: T[] = [];
  const seenPlayers = new Set<string>();
  const seenGames = new Set<string>();
  for (const leg of pool) {
    if (picked.length >= size) break;
    if (seenPlayers.has(leg.playerId)) continue;
    if (seenGames.has(leg.gameId)) continue;
    picked.push(leg);
    seenPlayers.add(leg.playerId);
    seenGames.add(leg.gameId);
  }
  return picked.length === size ? picked : null;
}
