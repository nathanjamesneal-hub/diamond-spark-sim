/**
 * Shared, read-only Monte Carlo metric normalizer.
 *
 * Given a persisted `distributions` JSON blob (either from
 * `forecast_player_projections.distributions` or
 * `projections.sim_snapshot.distributions`), return the mean / p10 / p50 /
 * p90 / event probability for a given market.
 *
 * NEVER runs a simulation, NEVER infers a mean from a probability, NEVER
 * fabricates a value. Returns `available: false` and `mean: null` when the
 * persisted snapshot does not carry the requested market.
 *
 * IMPORTANT: This helper is alias-safe (e.g. pitcher "outs" vs "OUTS") but
 * callers must always pre-select ONE snapshot (per the public forecast
 * selector) before invoking — never mix distributions from different runs.
 */

export type MarketRole = "hitter" | "pitcher";

export type HitterMarket =
  | "H" | "HR" | "TB" | "RBI" | "R" | "SB" | "BB" | "K" | "PA";

export type PitcherMarket =
  | "K" | "BB" | "ER" | "H" | "OUTS" | "BF" | "WIN" | "QS";

export type MarketKey = HitterMarket | PitcherMarket;

export type MarketSimulationMetrics = {
  available: boolean;
  mean: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  /** Persisted threshold/event probability when the snapshot carries one (0..1). */
  eventProbability: number | null;
  /** Dotted JSON path pointing at the specific key resolved (or null). */
  sourcePath: string | null;
};

const HITTER_ALIASES: Record<HitterMarket, string[]> = {
  H:   ["H", "h", "hits", "Hits"],
  HR:  ["HR", "hr", "home_runs", "HomeRuns"],
  TB:  ["TB", "tb", "total_bases", "TotalBases"],
  RBI: ["RBI", "rbi"],
  R:   ["R", "r", "runs", "Runs"],
  SB:  ["SB", "sb", "stolen_bases"],
  BB:  ["BB", "bb", "walks"],
  K:   ["K", "k", "strikeouts", "SO"],
  PA:  ["PA", "pa", "plate_appearances"],
};

const PITCHER_ALIASES: Record<PitcherMarket, string[]> = {
  K:    ["K", "k", "strikeouts", "SO"],
  BB:   ["BB", "bb", "walks"],
  ER:   ["ER", "er", "earned_runs"],
  H:    ["H", "h", "hits", "HitsAllowed"],
  OUTS: ["OUTS", "outs", "Outs", "outs_recorded"],
  BF:   ["BF", "bf", "batters_faced"],
  WIN:  ["WIN", "win", "W"],
  QS:   ["QS", "qs", "quality_start"],
};

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

/**
 * Find the first alias key actually present in `distributions` for the given
 * (role, market). Returns the resolved entry plus the dotted source path.
 */
function pickEntry(
  distributions: unknown,
  role: MarketRole,
  market: MarketKey,
): { entry: Record<string, unknown> | null; path: string | null } {
  if (!distributions || typeof distributions !== "object") return { entry: null, path: null };
  const aliases =
    (role === "pitcher" ? PITCHER_ALIASES : HITTER_ALIASES) as Record<string, string[]>;
  const list = aliases[market as string] ?? [market as string];
  const map = distributions as Record<string, unknown>;
  for (const key of list) {
    if (key in map && map[key] && typeof map[key] === "object") {
      return { entry: map[key] as Record<string, unknown>, path: `distributions.${key}` };
    }
  }
  return { entry: null, path: null };
}

export function getMarketSimulationMetrics(args: {
  distributions: unknown;
  role: MarketRole;
  market: MarketKey;
}): MarketSimulationMetrics {
  const empty: MarketSimulationMetrics = {
    available: false,
    mean: null, p10: null, p50: null, p90: null,
    eventProbability: null, sourcePath: null,
  };
  const { entry, path } = pickEntry(args.distributions, args.role, args.market);
  if (!entry) return empty;

  const mean = num(entry.mean);
  const p10 = num((entry as any).p10);
  const p50 = num((entry as any).p50);
  const p90 = num((entry as any).p90);
  // Persisted event probability: prefer probAtLeast1, then probAtLeast2, then
  // probability/eventProbability if a snapshot stored that shape directly.
  const eventProbability =
    num((entry as any).probAtLeast1) ??
    num((entry as any).probAtLeast2) ??
    num((entry as any).eventProbability) ??
    num((entry as any).probability);

  const available =
    mean != null || p10 != null || p50 != null || p90 != null || eventProbability != null;

  return {
    available,
    mean,
    p10,
    p50,
    p90,
    eventProbability,
    sourcePath: available ? path : null,
  };
}

export const NO_PERSISTED_MEAN_TOOLTIP =
  "No persisted Monte Carlo mean in this forecast snapshot";
