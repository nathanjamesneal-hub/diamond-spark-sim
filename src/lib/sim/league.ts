/**
 * League-average reference rates (per plate appearance) used for the log5
 * blend between batter and pitcher. Tuned to the modern offensive environment.
 */
export const LEAGUE = {
  K: 0.222,
  BB: 0.085,
  HBP: 0.011,
  HR: 0.030,
  H_1B: 0.140,
  H_2B: 0.045,
  H_3B: 0.004,
  // outs in play = remainder
  R_PER_PA: 0.118,
} as const;

export type Rates = {
  K: number; BB: number; HBP: number;
  HR: number; H_1B: number; H_2B: number; H_3B: number;
  OUT: number; // in-play out (no HR)
};

/**
 * log5(batter, pitcher, league) — Bill James's blending formula.
 * Returns the expected batter outcome rate against this pitcher.
 */
export function log5(b: number, p: number, l: number): number {
  const num = (b * p) / l;
  const denom = num + ((1 - b) * (1 - p)) / (1 - l);
  if (denom <= 0) return l;
  return num / denom;
}

/** Normalize a rate vector to sum to 1, treating negatives as 0. */
export function normalize(r: Rates): Rates {
  const keys: Array<keyof Rates> = ["K", "BB", "HBP", "HR", "H_1B", "H_2B", "H_3B", "OUT"];
  let total = 0;
  for (const k of keys) {
    if (r[k] < 0) r[k] = 0;
    total += r[k];
  }
  if (total <= 0) return r;
  for (const k of keys) r[k] = r[k] / total;
  return r;
}
