/**
 * Canonical Material Input Hash for Diamond forecasts.
 *
 * Only inputs that should legitimately change a forecast are hashed.
 * Excluded: updated_at, sync timestamps, page loads, live boxscore, RQ cache
 * state, Date.now(), RNG, and any roster-sync metadata.
 *
 * Pure module — no DB / no fetch. Safe to unit-test.
 */
import { createHash } from "node:crypto";

export type MaterialInputs = {
  gamePk: number;
  modelVersion: string;
  homeStarterMlbId: number;
  awayStarterMlbId: number;
  homeLineup: Array<{ mlbId: number; order: number }>;
  awayLineup: Array<{ mlbId: number; order: number }>;
  venueId: number | null;
  parkFactors?: Record<string, number | string | null> | null;
  gameEnvironment?: Record<string, unknown> | null;
};

export type MaterialInputCheck =
  | { ok: true; inputs: MaterialInputs }
  | { ok: false; reason: string };

/** Canonical normalization — keys sorted, lineups ordered, no extraneous fields. */
function canonicalize(i: MaterialInputs): Record<string, unknown> {
  const sortByOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;
  return {
    gamePk: i.gamePk,
    modelVersion: i.modelVersion,
    homeStarterMlbId: i.homeStarterMlbId,
    awayStarterMlbId: i.awayStarterMlbId,
    homeLineup: [...i.homeLineup].sort(sortByOrder).map((p) => [p.order, p.mlbId]),
    awayLineup: [...i.awayLineup].sort(sortByOrder).map((p) => [p.order, p.mlbId]),
    venueId: i.venueId ?? null,
    parkFactors: i.parkFactors ?? null,
    gameEnvironment: i.gameEnvironment ?? null,
  };
}

export function computeMaterialInputHash(inputs: MaterialInputs): string {
  const json = JSON.stringify(canonicalize(inputs));
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Deterministic 32-bit seed derived from inputHash + gamePk + modelVersion.
 * Same valid material inputs → same engine output bit-for-bit.
 */
export function deterministicSeed(
  gamePk: number,
  inputHash: string,
  modelVersion: string,
): number {
  const h = createHash("sha256")
    .update(`${gamePk}:${inputHash}:${modelVersion}`)
    .digest();
  // 32-bit unsigned, safe for JS number and for the engine's mulberry32 PRNG.
  return h.readUInt32BE(0);
}

/**
 * Validate that resolved inputs are complete enough to publish a forecast.
 * If any official-required input is missing, return a typed failure.
 */
export function validateMaterialInputs(
  candidate: Partial<MaterialInputs>,
): MaterialInputCheck {
  if (!candidate.gamePk) return { ok: false, reason: "missing gamePk" };
  if (!candidate.modelVersion) return { ok: false, reason: "missing modelVersion" };
  if (!candidate.homeStarterMlbId) return { ok: false, reason: "missing home probable starter" };
  if (!candidate.awayStarterMlbId) return { ok: false, reason: "missing away probable starter" };
  if (!candidate.homeLineup || candidate.homeLineup.length !== 9) {
    return { ok: false, reason: "home lineup not confirmed (need 9 batters)" };
  }
  if (!candidate.awayLineup || candidate.awayLineup.length !== 9) {
    return { ok: false, reason: "away lineup not confirmed (need 9 batters)" };
  }
  return { ok: true, inputs: candidate as MaterialInputs };
}
