/**
 * Small-sample shrinkage for batter / pitcher rate inputs.
 *
 * Applied at the input-profile layer BEFORE log5/simulation. Existing locked
 * forecast snapshots are untouched; only fresh sim runs see the corrected
 * counts. The engine math is unchanged — counts are returned in the same
 * shape, with each count = shrunkRate * sampleOpportunity (rounded).
 *
 * Formula (per outcome):
 *   priorOpportunity =
 *     MAX_PRIOR * clamp(1 - sampleOpportunity / FULL_TRUST_OPPORTUNITY, 0, 1)
 *
 *   shrunkRate =
 *     (rawEventCount + leagueRate * priorOpportunity) /
 *     (sampleOpportunity + priorOpportunity)
 *
 * League-average rates are the prior. Constants are intentionally explicit so
 * future tuning is a single-file edit.
 */
import { LEAGUE } from "./league.ts";

export const HITTER_FULL_TRUST_PA = 300;
export const HITTER_MAX_PRIOR_PA = 250;
export const PITCHER_FULL_TRUST_BF = 500;
export const PITCHER_MAX_PRIOR_BF = 400;

export type RateKey = "K" | "BB" | "HBP" | "HR" | "H_1B" | "H_2B" | "H_3B";

const HITTER_RATE_KEYS: RateKey[] = ["K", "BB", "HBP", "HR", "H_1B", "H_2B", "H_3B"];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export type ShrinkageEntry = {
  rawCount: number;
  rawRate: number;
  leagueRate: number;
  priorOpportunity: number;
  shrunkRate: number;
  shrunkCount: number;
};

export type ShrinkageDiagnostics = {
  sampleOpportunity: number;
  fullTrustOpportunity: number;
  maxPriorOpportunity: number;
  shrinkageWeight: number; // 0 = no shrinkage (full sample), 1 = max shrinkage (no sample)
  perOutcome: Record<RateKey, ShrinkageEntry>;
};

export type ShrunkHitterCounts = {
  K: number; BB: number; HBP: number; HR: number;
  H_1B: number; H_2B: number; H_3B: number;
  diagnostics: ShrinkageDiagnostics;
};

export type ShrunkPitcherCounts = ShrunkHitterCounts;

function priorOpportunity(sample: number, fullTrust: number, maxPrior: number): number {
  return maxPrior * clamp01(1 - sample / fullTrust);
}

function shrinkOne(
  raw: number,
  sample: number,
  leagueRate: number,
  prior: number,
): { rate: number; count: number } {
  const denom = sample + prior;
  const rate = denom <= 0 ? leagueRate : (raw + leagueRate * prior) / denom;
  const count = Math.max(0, Math.round(rate * sample));
  return { rate, count };
}

function buildDiagnostics(
  raw: Record<RateKey, number>,
  sample: number,
  fullTrust: number,
  maxPrior: number,
  prior: number,
): ShrinkageDiagnostics {
  const perOutcome = {} as Record<RateKey, ShrinkageEntry>;
  for (const k of HITTER_RATE_KEYS) {
    const leagueRate = (LEAGUE as any)[k] as number;
    const { rate, count } = shrinkOne(raw[k], sample, leagueRate, prior);
    perOutcome[k] = {
      rawCount: raw[k],
      rawRate: sample > 0 ? raw[k] / sample : 0,
      leagueRate,
      priorOpportunity: prior,
      shrunkRate: rate,
      shrunkCount: count,
    };
  }
  return {
    sampleOpportunity: sample,
    fullTrustOpportunity: fullTrust,
    maxPriorOpportunity: maxPrior,
    shrinkageWeight: maxPrior > 0 ? prior / maxPrior : 0,
    perOutcome,
  };
}

/**
 * Safely cap the sum of event counts so they never exceed sample opportunity
 * (the OUT remainder must stay non-negative in the engine).
 */
function capCountsToSample<T extends Record<RateKey, number>>(
  counts: T,
  sample: number,
): T {
  let total = 0;
  for (const k of HITTER_RATE_KEYS) total += counts[k];
  if (total <= sample) return counts;
  const scale = sample / total;
  const out = { ...counts };
  for (const k of HITTER_RATE_KEYS) out[k] = Math.floor(counts[k] * scale);
  return out;
}

export function shrinkHitterCounts(input: {
  pa: number;
  K: number; BB: number; HBP: number; HR: number;
  H_1B: number; H_2B: number; H_3B: number;
}): ShrunkHitterCounts {
  const sample = Math.max(0, input.pa);
  const prior = priorOpportunity(sample, HITTER_FULL_TRUST_PA, HITTER_MAX_PRIOR_PA);
  const raw: Record<RateKey, number> = {
    K: input.K, BB: input.BB, HBP: input.HBP, HR: input.HR,
    H_1B: input.H_1B, H_2B: input.H_2B, H_3B: input.H_3B,
  };
  const diagnostics = buildDiagnostics(raw, sample, HITTER_FULL_TRUST_PA, HITTER_MAX_PRIOR_PA, prior);
  const counts: Record<RateKey, number> = {
    K: diagnostics.perOutcome.K.shrunkCount,
    BB: diagnostics.perOutcome.BB.shrunkCount,
    HBP: diagnostics.perOutcome.HBP.shrunkCount,
    HR: diagnostics.perOutcome.HR.shrunkCount,
    H_1B: diagnostics.perOutcome.H_1B.shrunkCount,
    H_2B: diagnostics.perOutcome.H_2B.shrunkCount,
    H_3B: diagnostics.perOutcome.H_3B.shrunkCount,
  };
  const capped = capCountsToSample(counts, sample);
  return { ...capped, diagnostics };
}

export function shrinkPitcherCounts(input: {
  bf: number;
  K: number; BB: number; HBP: number; HR: number;
  H_1B: number; H_2B: number; H_3B: number;
}): ShrunkPitcherCounts {
  const sample = Math.max(0, input.bf);
  const prior = priorOpportunity(sample, PITCHER_FULL_TRUST_BF, PITCHER_MAX_PRIOR_BF);
  const raw: Record<RateKey, number> = {
    K: input.K, BB: input.BB, HBP: input.HBP, HR: input.HR,
    H_1B: input.H_1B, H_2B: input.H_2B, H_3B: input.H_3B,
  };
  const diagnostics = buildDiagnostics(raw, sample, PITCHER_FULL_TRUST_BF, PITCHER_MAX_PRIOR_BF, prior);
  const counts: Record<RateKey, number> = {
    K: diagnostics.perOutcome.K.shrunkCount,
    BB: diagnostics.perOutcome.BB.shrunkCount,
    HBP: diagnostics.perOutcome.HBP.shrunkCount,
    HR: diagnostics.perOutcome.HR.shrunkCount,
    H_1B: diagnostics.perOutcome.H_1B.shrunkCount,
    H_2B: diagnostics.perOutcome.H_2B.shrunkCount,
    H_3B: diagnostics.perOutcome.H_3B.shrunkCount,
  };
  const capped = capCountsToSample(counts, sample);
  return { ...capped, diagnostics };
}
