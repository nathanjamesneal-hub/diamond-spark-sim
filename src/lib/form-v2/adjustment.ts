import type { BatterProfile, PitcherProfile } from "@/lib/sim/engine";

export type FormRole = "hitter" | "pitcher";
export type FormEventKey = "K" | "BB" | "HBP" | "HR" | "H_1B" | "H_2B" | "H_3B";

export type RecentEventCounts = {
  role: FormRole;
  mlb_id: number;
  pa?: number | null;
  bf?: number | null;
  outs?: number | null;
  K?: number | null;
  BB?: number | null;
  HBP?: number | null;
  HR?: number | null;
  H_1B?: number | null;
  H_2B?: number | null;
  H_3B?: number | null;
  source?: string | null;
  source_fetched_at?: string | null;
};

export type FormAdjustmentField = {
  event: FormEventKey;
  seasonRate: number;
  recentRate: number | null;
  denominator: number;
  recentDenominator: number;
  priorDenominator: number;
  shrinkWeight: number;
  rawDelta: number | null;
  appliedDelta: number;
  cap: number;
  adjustedRate: number;
  status: "applied" | "insufficient_recent_sample" | "missing_recent_count" | "insufficient_season_sample";
};

export type FormAdjustmentMetadata = {
  role: FormRole;
  playerId: number;
  applied: boolean;
  reason: string | null;
  seasonDenominator: number;
  recentDenominator: number;
  source: string | null;
  sourceFetchedAt: string | null;
  fields: FormAdjustmentField[];
};

export type BatterFormAdjustmentResult = {
  profile: BatterProfile;
  metadata: FormAdjustmentMetadata;
};

export type PitcherFormAdjustmentResult = {
  profile: PitcherProfile;
  metadata: FormAdjustmentMetadata;
};

const EVENTS: FormEventKey[] = ["K", "BB", "HBP", "HR", "H_1B", "H_2B", "H_3B"];

const HITTER_RULES: Record<FormEventKey, { minRecent: number; prior: number; cap: number }> = {
  K: { minRecent: 20, prior: 60, cap: 0.035 },
  BB: { minRecent: 20, prior: 60, cap: 0.025 },
  HBP: { minRecent: 20, prior: 80, cap: 0.005 },
  HR: { minRecent: 30, prior: 120, cap: 0.012 },
  H_1B: { minRecent: 30, prior: 80, cap: 0.035 },
  H_2B: { minRecent: 30, prior: 100, cap: 0.015 },
  H_3B: { minRecent: 30, prior: 150, cap: 0.004 },
};

const PITCHER_RULES: Record<FormEventKey, { minRecent: number; prior: number; cap: number }> = {
  K: { minRecent: 25, prior: 70, cap: 0.035 },
  BB: { minRecent: 25, prior: 70, cap: 0.025 },
  HBP: { minRecent: 25, prior: 90, cap: 0.005 },
  HR: { minRecent: 40, prior: 140, cap: 0.012 },
  H_1B: { minRecent: 40, prior: 90, cap: 0.035 },
  H_2B: { minRecent: 40, prior: 120, cap: 0.015 },
  H_3B: { minRecent: 40, prior: 160, cap: 0.004 },
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeProfileRates(
  rates: Record<FormEventKey, number>,
): Record<FormEventKey, number> {
  const sumEvents = EVENTS.reduce((sum, k) => sum + Math.max(0, rates[k]), 0);
  const out = Math.max(0.02, 1 - sumEvents);
  const total = sumEvents + out;
  const normalized: Record<FormEventKey, number> = { ...rates };
  for (const key of EVENTS) normalized[key] = Math.max(0, normalized[key]) / total;
  return normalized;
}

function adjustRate(args: {
  event: FormEventKey;
  seasonCount: number;
  recentCount: number | null;
  seasonDenominator: number;
  recentDenominator: number;
  minRecent: number;
  prior: number;
  cap: number;
  seasonOk: boolean;
}): FormAdjustmentField {
  const seasonRate = args.seasonDenominator > 0 ? args.seasonCount / args.seasonDenominator : 0;
  if (!args.seasonOk) {
    return {
      event: args.event,
      seasonRate,
      recentRate: null,
      denominator: args.seasonDenominator,
      recentDenominator: args.recentDenominator,
      priorDenominator: args.prior,
      shrinkWeight: 0,
      rawDelta: null,
      appliedDelta: 0,
      cap: args.cap,
      adjustedRate: seasonRate,
      status: "insufficient_season_sample",
    };
  }
  if (args.recentDenominator < args.minRecent) {
    return {
      event: args.event,
      seasonRate,
      recentRate: null,
      denominator: args.seasonDenominator,
      recentDenominator: args.recentDenominator,
      priorDenominator: args.prior,
      shrinkWeight: 0,
      rawDelta: null,
      appliedDelta: 0,
      cap: args.cap,
      adjustedRate: seasonRate,
      status: "insufficient_recent_sample",
    };
  }
  if (args.recentCount == null) {
    return {
      event: args.event,
      seasonRate,
      recentRate: null,
      denominator: args.seasonDenominator,
      recentDenominator: args.recentDenominator,
      priorDenominator: args.prior,
      shrinkWeight: 0,
      rawDelta: null,
      appliedDelta: 0,
      cap: args.cap,
      adjustedRate: seasonRate,
      status: "missing_recent_count",
    };
  }

  const recentRate = args.recentCount / args.recentDenominator;
  const shrinkWeight = args.recentDenominator / (args.recentDenominator + args.prior);
  const rawDelta = recentRate - seasonRate;
  const appliedDelta = clamp(shrinkWeight * rawDelta, -args.cap, args.cap);
  return {
    event: args.event,
    seasonRate,
    recentRate,
    denominator: args.seasonDenominator,
    recentDenominator: args.recentDenominator,
    priorDenominator: args.prior,
    shrinkWeight,
    rawDelta,
    appliedDelta,
    cap: args.cap,
    adjustedRate: seasonRate + appliedDelta,
    status: "applied",
  };
}

export function adjustBatterProfileForRecentForm(
  profile: BatterProfile,
  recent: RecentEventCounts | null | undefined,
): BatterFormAdjustmentResult {
  const seasonDenominator = profile.pa;
  const recentDenominator = finiteNumber(recent?.pa) ?? 0;
  const seasonOk = seasonDenominator >= 50;
  const fields = EVENTS.map((event) => adjustRate({
    event,
    seasonCount: finiteNumber(profile[event]) ?? 0,
    recentCount: finiteNumber(recent?.[event]),
    seasonDenominator,
    recentDenominator,
    minRecent: HITTER_RULES[event].minRecent,
    prior: HITTER_RULES[event].prior,
    cap: HITTER_RULES[event].cap,
    seasonOk,
  }));

  const normalizedRates = normalizeProfileRates(Object.fromEntries(
    fields.map((field) => [field.event, field.adjustedRate]),
  ) as Record<FormEventKey, number>);
  const adjusted: BatterProfile = { ...profile };
  for (const event of EVENTS) adjusted[event] = normalizedRates[event] * seasonDenominator;

  const applied = fields.some((field) => field.status === "applied" && field.appliedDelta !== 0);
  const reason = !seasonOk
    ? "season PA below 50"
    : !recent
      ? "missing recent counts"
      : applied
        ? null
        : "no eligible recent adjustments";
  return {
    profile: applied ? adjusted : { ...profile },
    metadata: {
      role: "hitter",
      playerId: profile.id,
      applied,
      reason,
      seasonDenominator,
      recentDenominator,
      source: recent?.source ?? null,
      sourceFetchedAt: recent?.source_fetched_at ?? null,
      fields,
    },
  };
}

export function adjustPitcherProfileForRecentForm(
  profile: PitcherProfile,
  recent: RecentEventCounts | null | undefined,
): PitcherFormAdjustmentResult {
  const seasonDenominator = profile.bf;
  const recentDenominator = finiteNumber(recent?.bf) ?? 0;
  const seasonOk = seasonDenominator >= 50;
  const fields = EVENTS.map((event) => adjustRate({
    event,
    seasonCount: finiteNumber(profile[event]) ?? 0,
    recentCount: finiteNumber(recent?.[event]),
    seasonDenominator,
    recentDenominator,
    minRecent: PITCHER_RULES[event].minRecent,
    prior: PITCHER_RULES[event].prior,
    cap: PITCHER_RULES[event].cap,
    seasonOk,
  }));

  const normalizedRates = normalizeProfileRates(Object.fromEntries(
    fields.map((field) => [field.event, field.adjustedRate]),
  ) as Record<FormEventKey, number>);
  const adjusted: PitcherProfile = { ...profile };
  for (const event of EVENTS) adjusted[event] = normalizedRates[event] * seasonDenominator;

  const applied = fields.some((field) => field.status === "applied" && field.appliedDelta !== 0);
  const reason = !seasonOk
    ? "season BF below 50"
    : !recent
      ? "missing recent counts"
      : applied
        ? null
        : "no eligible recent adjustments";
  return {
    profile: applied ? adjusted : { ...profile },
    metadata: {
      role: "pitcher",
      playerId: profile.id,
      applied,
      reason,
      seasonDenominator,
      recentDenominator,
      source: recent?.source ?? null,
      sourceFetchedAt: recent?.source_fetched_at ?? null,
      fields,
    },
  };
}
