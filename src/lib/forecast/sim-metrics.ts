/**
 * Shared, read-only Monte Carlo metric normalizer.
 *
 * Rules:
 *  - The caller must select the public forecast first (locked official →
 *    published official → pregame preview). This helper only reads sources
 *    tied to that same selected forecast/run/snapshot.
 *  - Source priority is exact-run FPP distributions, then the selected
 *    projections.sim_snapshot.distributions, then unavailable.
 *  - This helper does not run simulations, write data, synthesize means, or
 *    infer a mean from probability.
 */

export type MarketRole = "hitter" | "pitcher";

export type MarketKey =
  // Hitter
  | "H" | "HR" | "TB" | "RBI" | "R" | "SB" | "BB" | "K" | "PA"
  // Pitcher
  | "OUTS" | "BF" | "ER";

export type ProjectionClass = "official" | "preview" | string | null | undefined;

export type SelectedForecastSnapshot = {
  forecastRunId?: string | null;
  projectionClass?: ProjectionClass;
  /** Exact selected forecast_player_projections.distributions blob, if present. */
  fppDistributions?: unknown;
  /** Exact selected projections.sim_snapshot JSON blob, if present. */
  projectionSimSnapshot?: unknown;
};

export type SimulationMetrics = {
  mean: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  eventProbability: number | null;
  probAtLeast1: number | null;
  probAtLeast2: number | null;
  sourcePath: string | null;
  fppPathTried: string;
  simSnapshotPathTried: string;
  availableDistributionKeys: string[];
  /** true only when a numeric raw mean is persisted for this selected market. */
  available: boolean;
  unavailableReason: string | null;
};

export const NO_PERSISTED_MEAN_TOOLTIP =
  "No persisted Monte Carlo mean in this selected forecast snapshot";

const MARKET_ALIASES: Record<MarketKey, string[]> = {
  H:    ["H", "h", "hits", "HITS"],
  HR:   ["HR", "hr", "homeRuns", "home_runs", "homeRun", "home_run"],
  TB:   ["TB", "tb", "totalBases", "total_bases", "totalBase", "total_base"],
  RBI:  ["RBI", "rbi", "rbis"],
  R:    ["R", "r", "runs", "run"],
  SB:   ["SB", "sb", "stolenBases", "stolen_bases", "stolenBase", "stolen_base"],
  BB:   ["BB", "bb", "walks", "baseOnBalls", "base_on_balls"],
  K:    ["K", "k", "strikeouts", "strikeOuts", "strike_outs", "SO", "so"],
  PA:   ["PA", "pa", "plateAppearances", "plate_appearances"],
  OUTS: ["OUTS", "outs", "out", "outs_recorded", "outsRecorded"],
  BF:   ["BF", "bf", "battersFaced", "batters_faced"],
  ER:   ["ER", "er", "earnedRuns", "earned_runs"],
};

export function marketAliases(market: MarketKey): string[] {
  return MARKET_ALIASES[market] ?? [market];
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function distributionMapFromSnapshot(snapshot: unknown): Record<string, unknown> | null {
  const obj = asObject(snapshot);
  const d = obj?.distributions;
  return asObject(d);
}

function availableKeys(...maps: Array<Record<string, unknown> | null>): string[] {
  const s = new Set<string>();
  for (const m of maps) {
    if (!m) continue;
    for (const k of Object.keys(m)) s.add(k);
  }
  return Array.from(s).sort((a, b) => a.localeCompare(b));
}

function pickEntry(dists: Record<string, unknown> | null, market: MarketKey): { entry: Record<string, unknown>; key: string } | null {
  if (!dists) return null;
  const directAliases = MARKET_ALIASES[market] ?? [market];
  for (const alias of directAliases) {
    if (Object.prototype.hasOwnProperty.call(dists, alias)) {
      const entry = asObject(dists[alias]);
      if (entry) return { entry, key: alias };
    }
  }
  const normalizedAliases = new Set(directAliases.map(normalizeKey));
  for (const [key, raw] of Object.entries(dists)) {
    if (!normalizedAliases.has(normalizeKey(key))) continue;
    const entry = asObject(raw);
    if (entry) return { entry, key };
  }
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (isFinite(n)) return n;
  }
  return null;
}

function pickNum(entry: Record<string, unknown>, aliases: readonly string[]): number | null {
  for (const a of aliases) {
    if (Object.prototype.hasOwnProperty.call(entry, a)) {
      const n = num(entry[a]);
      if (n != null) return n;
    }
  }
  const normalized = new Set(aliases.map(normalizeKey));
  for (const [key, value] of Object.entries(entry)) {
    if (!normalized.has(normalizeKey(key))) continue;
    const n = num(value);
    if (n != null) return n;
  }
  return null;
}

function readMetrics(entry: Record<string, unknown>) {
  const probAtLeast1 = pickNum(entry, ["probAtLeast1", "prob_at_least_1", "pAtLeast1", "prob1Plus", "prob_1_plus"]);
  const probAtLeast2 = pickNum(entry, ["probAtLeast2", "prob_at_least_2", "pAtLeast2", "prob2Plus", "prob_2_plus"]);
  return {
    mean: pickNum(entry, ["mean", "avg", "average", "mu"]),
    p10: pickNum(entry, ["p10", "P10", "percentile10", "percentile_10"]),
    p50: pickNum(entry, ["p50", "P50", "median", "percentile50", "percentile_50"]),
    p90: pickNum(entry, ["p90", "P90", "percentile90", "percentile_90"]),
    probAtLeast1,
    probAtLeast2,
    eventProbability: pickNum(entry, ["eventProbability", "event_probability", "probability", "prob"]) ?? probAtLeast1,
  };
}

function classLabel(projectionClass: ProjectionClass): string {
  return projectionClass ? String(projectionClass) : "forecast";
}

function emptyMetric(args: {
  selectedForecast: SelectedForecastSnapshot | null | undefined;
  market: MarketKey;
  fppPathTried: string;
  simSnapshotPathTried: string;
  keys: string[];
  reason?: string;
}): SimulationMetrics {
  return {
    mean: null,
    p10: null,
    p50: null,
    p90: null,
    eventProbability: null,
    probAtLeast1: null,
    probAtLeast2: null,
    sourcePath: null,
    fppPathTried: args.fppPathTried,
    simSnapshotPathTried: args.simSnapshotPathTried,
    availableDistributionKeys: args.keys,
    available: false,
    unavailableReason: args.reason ?? `No ${args.market}.mean persisted in this selected ${classLabel(args.selectedForecast?.projectionClass)} snapshot`,
  };
}

/**
 * Extract one market from the exact selected public forecast snapshot.
 */
export function getMarketSimulationMetrics(args: {
  selectedForecast: SelectedForecastSnapshot | null | undefined;
  role: MarketRole;
  market: MarketKey;
}): SimulationMetrics {
  const fppDist = asObject(args.selectedForecast?.fppDistributions);
  const snapDist = distributionMapFromSnapshot(args.selectedForecast?.projectionSimSnapshot);
  const keys = availableKeys(fppDist, snapDist);
  const fppDefaultPath = `forecast_player_projections.distributions.${args.market}.mean`;
  const snapDefaultPath = `projections.sim_snapshot.distributions.${args.market}.mean`;

  if (!args.selectedForecast) {
    return emptyMetric({
      selectedForecast: args.selectedForecast,
      market: args.market,
      fppPathTried: fppDefaultPath,
      simSnapshotPathTried: snapDefaultPath,
      keys,
      reason: "No selected public forecast snapshot",
    });
  }

  const sources: Array<{
    name: "forecast_player_projections.distributions" | "projections.sim_snapshot.distributions";
    dist: Record<string, unknown> | null;
  }> = [
    { name: "forecast_player_projections.distributions", dist: fppDist },
    { name: "projections.sim_snapshot.distributions", dist: snapDist },
  ];

  let fppPathTried = fppDefaultPath;
  let simSnapshotPathTried = snapDefaultPath;
  let foundEntryWithoutMean: { path: string } | null = null;

  for (const source of sources) {
    const hit = pickEntry(source.dist, args.market);
    if (!hit) continue;
    const sourcePath = `${source.name}.${hit.key}`;
    if (source.name === "forecast_player_projections.distributions") fppPathTried = `${sourcePath}.mean`;
    else simSnapshotPathTried = `${sourcePath}.mean`;

    const m = readMetrics(hit.entry);
    if (m.mean != null) {
      return {
        ...m,
        sourcePath,
        fppPathTried,
        simSnapshotPathTried,
        availableDistributionKeys: keys,
        available: true,
        unavailableReason: null,
      };
    }
    foundEntryWithoutMean = { path: sourcePath };
  }

  return emptyMetric({
    selectedForecast: args.selectedForecast,
    market: args.market,
    fppPathTried,
    simSnapshotPathTried,
    keys,
    reason: foundEntryWithoutMean
      ? `No ${args.market}.mean persisted at ${foundEntryWithoutMean.path}`
      : `No ${args.market}.mean persisted in this selected ${classLabel(args.selectedForecast.projectionClass)} snapshot`,
  });
}

export function metricsToSimStat(m: SimulationMetrics): {
  mean: number | null;
  p50: number | null;
  p90: number | null;
  stdev: null;
  probAtLeast1: number | null;
  probAtLeast2: number | null;
} | null {
  if (!m.available && m.p50 == null && m.p90 == null && m.probAtLeast1 == null && m.probAtLeast2 == null) return null;
  return {
    mean: m.mean,
    p50: m.p50,
    p90: m.p90,
    stdev: null,
    probAtLeast1: m.probAtLeast1,
    probAtLeast2: m.probAtLeast2,
  };
}
