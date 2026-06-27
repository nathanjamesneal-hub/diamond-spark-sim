/**
 * Shared, read-only classifier for count-stat projection results.
 *
 * Purpose: a forecast with a non-positive persisted Monte Carlo mean (or no
 * projected opportunity) must NEVER be rendered as a successful projection,
 * even if the player ended with the actual stat at 0. Zero-vs-zero is not
 * a model success — it is "no meaningful stat projection".
 *
 * IMPORTANT
 *  - This helper does NOT rerun simulations, regrade probabilities, or
 *    mutate snapshots. It only labels rows for display/aggregation.
 *  - Use the RAW unrounded persisted mean. Do not pass a value that was
 *    pre-formatted/rounded for display.
 *  - Binary event-probability calibration (Brier / log loss / HR / SB /
 *    Win / QS) must NOT use this helper — it is for COUNT-stat means.
 */

export type CountProjectionStatus =
  // No persisted Monte Carlo mean available on the selected snapshot.
  | "missing"
  // rawMean <= 0 OR projected opportunity (PA / BF) is zero / unavailable.
  | "no-meaningful"
  // Has a positive mean — caller grades normally with its category logic.
  | "gradable";

export type CountProjectionClassification = {
  status: CountProjectionStatus;
  /** UI badge text. */
  badge: "N/A" | "—" | "OK";
  /** Human label used in cells / tooltips. */
  label: string;
  /** Long tooltip describing why the row is N/A (only set when not gradable). */
  tooltip: string | null;
  /** True for missing/no-meaningful — caller must NOT count these as success
   *  and must exclude them from accuracy/hit-rate denominators. */
  excludeFromAccuracy: boolean;
};

export const NO_PROJECTION_TOOLTIP =
  "No projection available on this snapshot.";
export const NO_MEANINGFUL_TOOLTIP =
  "This forecast had no positive persisted mean or projected opportunity, so it is excluded from count-stat grading.";

export function classifyCountProjection(args: {
  rawMean: number | null | undefined;
  /** Actual is allowed for callers that still want to display it. */
  actual?: number | null;
  /** Projected opportunity (PA for hitters, BF for pitchers). Pass undefined
   *  if the caller cannot resolve it; that alone will NOT mark the row
   *  N/A — only when it is explicitly 0 or known-missing alongside the
   *  zero-mean case. */
  projectedOpportunity?: number | null;
  /** True if a persisted metric exists for this market on the selected
   *  snapshot (e.g. distributions["H"]). */
  hasPersistedMetric: boolean;
}): CountProjectionClassification {
  const m = args.rawMean;
  if (!args.hasPersistedMetric || m == null || !Number.isFinite(m)) {
    return {
      status: "missing",
      badge: "N/A",
      label: "No projection available",
      tooltip: NO_PROJECTION_TOOLTIP,
      excludeFromAccuracy: true,
    };
  }
  const oppKnownZero =
    args.projectedOpportunity != null &&
    Number.isFinite(args.projectedOpportunity) &&
    (args.projectedOpportunity as number) <= 0;
  if (m <= 0 || oppKnownZero) {
    return {
      status: "no-meaningful",
      badge: "N/A",
      label: "No meaningful stat projection",
      tooltip: NO_MEANINGFUL_TOOLTIP,
      excludeFromAccuracy: true,
    };
  }
  return {
    status: "gradable",
    badge: "OK",
    label: "Gradable",
    tooltip: null,
    excludeFromAccuracy: false,
  };
}

/**
 * Precision-safe mean formatter. Uses the RAW mean — never the rounded
 * display string — to decide whether to render `<0.1` / `<0.01` so a real
 * tiny positive projection is not confused with an exact zero.
 */
export function formatProjectionMean(
  rawMean: number | null | undefined,
  digits: number = 2,
): string {
  if (rawMean == null || !Number.isFinite(rawMean)) return "—";
  if (rawMean <= 0) return "0";
  const minDisplay = Math.pow(10, -digits); // e.g. 0.01 for digits=2
  if (rawMean < minDisplay) {
    return digits >= 2 ? "<0.01" : "<0.1";
  }
  return rawMean.toFixed(digits);
}
