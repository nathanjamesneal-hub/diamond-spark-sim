/**
 * Shared, read-only Monte Carlo metric normalizer.
 *
 * Rules:
 *  - The selected `distributions` blob must already come from the SAME
 *    selected forecast/run/version (FPP for that run, or that row's
 *    projections.sim_snapshot). This helper never mixes sources.
 *  - This helper does not run any simulation, never writes, and never
 *    interpolates missing means.
 */

export type MarketRole = "hitter" | "pitcher";

export type MarketKey =
  // Hitter
  | "H" | "HR" | "TB" | "RBI" | "R" | "SB" | "BB" | "K" | "PA"
  // Pitcher
  | "OUTS" | "BF" | "ER";

export type SimulationMetrics = {
  mean: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  eventProbability: number | null;
  sourcePath: string | null;
  available: boolean;
};

export const NO_PERSISTED_MEAN_TOOLTIP =
  "No persisted Monte Carlo mean in this forecast snapshot";

const MARKET_ALIASES: Record<MarketKey, string[]> = {
  H:    ["H", "h", "hits", "HITS"],
  HR:   ["HR", "hr", "homeRuns", "home_runs"],
  TB:   ["TB", "tb", "totalBases", "total_bases"],
  RBI:  ["RBI", "rbi", "rbis"],
  R:    ["R", "r", "runs"],
  SB:   ["SB", "sb", "stolenBases", "stolen_bases"],
  BB:   ["BB", "bb", "walks"],
  K:    ["K", "k", "strikeouts", "SO", "so"],
  PA:   ["PA", "pa", "plate_appearances"],
  OUTS: ["OUTS", "outs", "outs_recorded"],
  BF:   ["BF", "bf", "batters_faced"],
  ER:   ["ER", "er", "earned_runs"],
};

function pickEntry(dists: Record<string, unknown>, market: MarketKey): { entry: any; key: string } | null {
  for (const alias of MARKET_ALIASES[market]) {
    if (alias in dists) {
      const v = dists[alias];
      if (v && typeof v === "object") return { entry: v, key: alias };
    }
  }
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

/**
 * Extract the Monte Carlo metrics for one market from a persisted
 * distributions blob (either forecast_player_projections.distributions
 * or projections.sim_snapshot.distributions for the SAME selected row).
 */
export function getMarketSimulationMetrics(args: {
  distributions: unknown;
  role: MarketRole;
  market: MarketKey;
}): SimulationMetrics {
  const empty: SimulationMetrics = {
    mean: null, p10: null, p50: null, p90: null,
    eventProbability: null, sourcePath: null, available: false,
  };
  const d = args.distributions;
  if (!d || typeof d !== "object") return empty;
  const dists = d as Record<string, unknown>;
  const hit = pickEntry(dists, args.market);
  if (!hit) return empty;
  const e = hit.entry as Record<string, unknown>;
  const mean = num(e.mean);
  const p10 = num(e.p10);
  const p50 = num(e.p50) ?? num(e.median);
  const p90 = num(e.p90);
  const eventProbability =
    num(e.probAtLeast1) ?? num(e.prob_at_least_1) ?? num(e.eventProbability) ?? null;
  const available = mean != null || p50 != null || eventProbability != null;
  return {
    mean, p10, p50, p90, eventProbability,
    sourcePath: available ? `distributions.${hit.key}` : null,
    available,
  };
}
