/**
 * Diamond Engine Beta — supported categories.
 * Only categories with persisted, trustworthy baseline Monte Carlo distributions
 * (see forecast_player_projections.distributions and monte_carlo_form_shadow_*)
 * AND a completed-game grading path via projection_results are exposed here.
 *
 * Explicitly excluded (per audit / spec): RBI, R, SB, Pitcher Wins,
 * Quality Starts, Earned Runs.
 */

export type EngineBetaRole = "hitter" | "pitcher";
export type EngineBetaCategoryKey =
  | "H"      // hits
  | "TB"     // total bases
  | "HR"     // home runs
  | "BB"     // walks
  | "K"      // strikeouts (hitter)
  | "P_K"    // strikeouts (pitcher)
  | "P_OUTS" // outs recorded
  | "P_BB"   // walks allowed
  | "P_H";   // hits allowed

export type EngineBetaCategory = {
  key: EngineBetaCategoryKey;
  role: EngineBetaRole;
  label: string;
  short: string;
  /** distributions key stored under forecast_player_projections.distributions */
  distKey: string;
  /** projection_results column to compare actuals against */
  actualsField: keyof {
    hits: number; total_bases: number; home_runs: number; walks: number;
    strikeouts: number; runs: number; rbis: number; stolen_bases: number;
    plate_appearances: number;
  };
  /** binary threshold used for hit/miss grading (line-1.5 == over 1.5) */
  threshold: number;
  higherIsBetter: boolean;
  /** natural-language event this row's probability refers to (e.g. "1+ Hit") */
  eventLabel: string;
  /** unit for the expected (mean) value (e.g. "expected hits") */
  meanUnit: string;
  /** whether a stored P(≥N) matching threshold is available (only P(≥1) is persisted today) */
  hasStoredProbAtThreshold: boolean;
};

export const ENGINE_BETA_CATEGORIES: EngineBetaCategory[] = [
  { key: "H",      role: "hitter",  label: "Hits",            short: "H",    distKey: "H",    actualsField: "hits",              threshold: 0.5,  higherIsBetter: true,  eventLabel: "1+ Hit",              meanUnit: "expected hits",               hasStoredProbAtThreshold: true  },
  { key: "TB",     role: "hitter",  label: "Total Bases",     short: "TB",   distKey: "TB",   actualsField: "total_bases",       threshold: 1.5,  higherIsBetter: true,  eventLabel: "2+ Total Bases",      meanUnit: "expected total bases",        hasStoredProbAtThreshold: false },
  { key: "HR",     role: "hitter",  label: "Home Runs",       short: "HR",   distKey: "HR",   actualsField: "home_runs",         threshold: 0.5,  higherIsBetter: true,  eventLabel: "1+ HR",               meanUnit: "expected home runs",          hasStoredProbAtThreshold: true  },
  { key: "BB",     role: "hitter",  label: "Walks",           short: "BB",   distKey: "BB",   actualsField: "walks",             threshold: 0.5,  higherIsBetter: true,  eventLabel: "1+ Walk",             meanUnit: "expected walks",              hasStoredProbAtThreshold: true  },
  { key: "K",      role: "hitter",  label: "Strikeouts",      short: "K",    distKey: "K",    actualsField: "strikeouts",        threshold: 0.5,  higherIsBetter: false, eventLabel: "0 Strikeouts",        meanUnit: "expected strikeouts",         hasStoredProbAtThreshold: true  },
  { key: "P_K",    role: "pitcher", label: "Strikeouts",      short: "K",    distKey: "K",    actualsField: "strikeouts",        threshold: 5.5,  higherIsBetter: true,  eventLabel: "6+ Strikeouts",       meanUnit: "expected pitcher strikeouts", hasStoredProbAtThreshold: false },
  { key: "P_OUTS", role: "pitcher", label: "Outs Recorded",   short: "Outs", distKey: "outs", actualsField: "plate_appearances", threshold: 17.5, higherIsBetter: true,  eventLabel: "18+ Outs (6 IP)",     meanUnit: "expected outs recorded",      hasStoredProbAtThreshold: false },
  { key: "P_BB",   role: "pitcher", label: "Walks Allowed",   short: "BB",   distKey: "BB",   actualsField: "walks",             threshold: 1.5,  higherIsBetter: false, eventLabel: "≤1 Walks Allowed",    meanUnit: "expected walks allowed",      hasStoredProbAtThreshold: false },
  { key: "P_H",    role: "pitcher", label: "Hits Allowed",    short: "H",    distKey: "H",    actualsField: "hits",              threshold: 5.5,  higherIsBetter: false, eventLabel: "≤5 Hits Allowed",     meanUnit: "expected hits allowed",       hasStoredProbAtThreshold: false },
];

export function findCategory(key: string): EngineBetaCategory | null {
  return ENGINE_BETA_CATEGORIES.find((c) => c.key === key) ?? null;
}

/**
 * Categories intentionally NOT modeled here. Kept as a first-class list so the
 * UI can render "Not currently modeled" affordances instead of inventing data.
 */
export const EXCLUDED_CATEGORIES = [
  { key: "RBI", label: "RBI", reason: "No trustworthy persisted RBI distribution + grading path" },
  { key: "R",   label: "Runs", reason: "No trustworthy persisted runs distribution + grading path" },
  { key: "SB",  label: "Stolen Bases", reason: "Not modeled in Alpha 0.3.1 baseline" },
  { key: "WIN", label: "Pitcher Wins", reason: "Team-dependent; not a persisted per-pitcher distribution" },
  { key: "QS",  label: "Quality Starts", reason: "Persisted probability only; no distribution+grading contract" },
  { key: "ER",  label: "Earned Runs", reason: "Baseline persisted, but grading path (unearned vs earned) not audited yet" },
] as const;
