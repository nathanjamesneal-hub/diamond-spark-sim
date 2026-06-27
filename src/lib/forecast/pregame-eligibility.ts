/**
 * Pregame-candidate eligibility gate for ranked public surfaces.
 *
 * Read-only. Pure function. Does NOT run sims, write data, or touch the
 * lifecycle. A row that fails this check must be excluded from any RANKED
 * leaderboard (Forecast Board sorted tiers, Top Props, Sim Leaders, Diamond
 * Consensus, Today Top Forecasts, Projection Lab public list).
 *
 * The bar is intentionally strict: probability alone is not enough. To rank
 * in a market we require both (a) a finite positive persisted Monte Carlo
 * mean for THAT market from the same selected snapshot, and (b) a finite
 * threshold probability for markets that expose one.
 */

import type { MarketKey, MarketRole, SimulationMetrics } from "./sim-metrics";
import type {
  PublicProjectionClass,
  SelectedPublicForecastCandidate,
} from "./select-public";

export type EligibilityReason =
  | "no_snapshot"
  | "post_lock_addition"
  | "no_lineup_slot"
  | "missing_market_mean"
  | "non_positive_market_mean"
  | "missing_market_prob"
  | "cross_run_mismatch";

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: EligibilityReason };

export type PregameLineupContext = {
  /** 1..9 for a real batting-order slot, null if absent. */
  battingOrder: number | null;
  /** true when the lineup row is confirmed or locked (not a "waiting" guess). */
  confirmed: boolean;
};

export type EligibilityArgs = {
  role: MarketRole;
  market: MarketKey;
  /** Result of selectBestPublicForecast (or null if nothing was selected). */
  selectedForecast: Pick<
    SelectedPublicForecastCandidate,
    "projectionClass" | "run" | "projection"
  > | null;
  /** Result of getMarketSimulationMetrics for the same selected forecast + market. */
  simMetrics: SimulationMetrics | null;
  /** Probability persisted on the SAME projections row for this market.
   *  Pass null when the market has no threshold probability (e.g. K, OUTS, BB). */
  probability: number | null;
  /** Whether the market exposes a threshold probability that must be present. */
  marketHasProbability: boolean;
  /** Hitter lineup context, or null for pitchers (validated by starting_pitchers). */
  lineup?: PregameLineupContext | null;
  /** True when callers have already detected this row as a post-first-pitch sub. */
  isPostLockAddition?: boolean;
};

function isFinitePositive(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function isFiniteAny(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function isEligiblePregameForecastCandidate(args: EligibilityArgs): EligibilityResult {
  if (args.isPostLockAddition) {
    return { eligible: false, reason: "post_lock_addition" };
  }

  if (!args.selectedForecast || !args.selectedForecast.run?.id || !args.selectedForecast.projection) {
    return { eligible: false, reason: "no_snapshot" };
  }

  // Hitter must have a real 1..9 slot in a confirmed/locked lineup.
  if (args.role === "hitter") {
    const lu = args.lineup;
    const bo = lu?.battingOrder ?? null;
    if (!lu || bo == null || !Number.isFinite(bo) || bo < 1 || bo > 9 || !lu.confirmed) {
      return { eligible: false, reason: "no_lineup_slot" };
    }
  }

  // Same-run guarantee: getMarketSimulationMetrics is always called with the
  // SAME selectedForecast tuple, so a non-null SimulationMetrics here cannot
  // come from a different run. We still assert presence.
  const m = args.simMetrics;
  if (!m) return { eligible: false, reason: "missing_market_mean" };
  if (m.mean == null) return { eligible: false, reason: "missing_market_mean" };
  if (!isFiniteAny(m.mean)) return { eligible: false, reason: "missing_market_mean" };
  if (!isFinitePositive(m.mean)) return { eligible: false, reason: "non_positive_market_mean" };

  if (args.marketHasProbability && !isFiniteAny(args.probability)) {
    return { eligible: false, reason: "missing_market_prob" };
  }

  return { eligible: true };
}

/** Convenience: returns true when the row may rank in this market. */
export function isRankableInMarket(args: EligibilityArgs): boolean {
  return isEligiblePregameForecastCandidate(args).eligible === true;
}

export type PerMarketEligibility = Partial<Record<MarketKey, EligibilityResult>>;

export type IneligibilityCounts = Partial<Record<EligibilityReason, number>>;

export function tallyReasons(results: ReadonlyArray<EligibilityResult>): IneligibilityCounts {
  const out: IneligibilityCounts = {};
  for (const r of results) {
    if (r.eligible) continue;
    out[r.reason] = (out[r.reason] ?? 0) + 1;
  }
  return out;
}

/** Projection-class echo, useful for diagnostics rendering. */
export function classOf(pc: PublicProjectionClass | string | null | undefined): string {
  return pc ? String(pc) : "unknown";
}
