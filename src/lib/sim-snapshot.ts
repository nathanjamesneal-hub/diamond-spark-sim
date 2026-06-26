/**
 * Sim Snapshot — immutable pregame Monte Carlo distributions.
 *
 * The writer lives in ingest.functions.ts and persists into
 * projections.sim_snapshot once per (game_id, player_id) on the final
 * pregame projection run after a lineup is confirmed/locked. The reader
 * lives in sim.functions.ts (historical path) and never re-runs the
 * simulator for past dates.
 *
 * No new math, scoring, or probability calculations live here — this file
 * only reshapes existing engine outputs (BatterDist, PitcherDist) into the
 * JSONB shape we persist + read back.
 */
import type {
  BatterDist,
  PitcherDist,
  PlayerStatDist,
  SimResult,
} from "./sim/engine";
import type { SimStat } from "./sim.functions";

export type StoredStatDist = {
  mean: number | null;
  p50: number | null;
  p90: number | null;
  stdev: number | null;
  probAtLeast1: number | null;
  probAtLeast2: number | null;
};

export type StoredHitterDistributions = {
  H?: StoredStatDist;
  HR?: StoredStatDist;
  TB?: StoredStatDist;
  RBI?: StoredStatDist;
  R?: StoredStatDist;
  K?: StoredStatDist;
  BB?: StoredStatDist;
};

export type StoredPitcherDistributions = {
  outs?: StoredStatDist;
  K?: StoredStatDist;
  BB?: StoredStatDist;
  ER?: StoredStatDist;
  H?: StoredStatDist;
};

export type SimSnapshot = {
  captured_at: string;
  snapshot_status: "locked";
  game_pk: number | null;
  game_id: string;
  player_id: string;
  mlb_id: number | null;
  projection_role: "hitter" | "pitcher";
  lineup_hash: string | null;
  model_version: string | null;
  iterations: number;
  distributions: StoredHitterDistributions | StoredPitcherDistributions;
};

function reshape(d: PlayerStatDist | undefined | null): StoredStatDist | undefined {
  if (!d) return undefined;
  const num = (v: unknown): number | null =>
    typeof v === "number" && isFinite(v) ? v : null;
  return {
    mean: num(d.mean),
    p50: num(d.p50),
    p90: num(d.p90),
    stdev: null, // engine does not expose stdev
    probAtLeast1: num(d.probAtLeast1),
    probAtLeast2: num(d.probAtLeast2),
  };
}

export function reshapeStoredToSimStat(
  d: StoredStatDist | undefined | null,
): SimStat | null {
  if (!d) return null;
  return {
    mean: d.mean,
    p50: d.p50,
    p90: d.p90,
    stdev: d.stdev,
    probAtLeast1: d.probAtLeast1,
    probAtLeast2: d.probAtLeast2,
  };
}

export function buildHitterSnapshot(args: {
  dist: BatterDist;
  game_id: string;
  game_pk: number | null;
  player_id: string;
  mlb_id: number | null;
  model_version: string | null;
  iterations: number;
  lineup_hash?: string | null;
}): SimSnapshot {
  const { dist } = args;
  const distributions: StoredHitterDistributions = {
    H: reshape(dist.H),
    HR: reshape(dist.HR),
    TB: reshape(dist.TB),
    RBI: reshape(dist.RBI),
    R: reshape(dist.R),
    K: reshape(dist.K),
    BB: reshape(dist.BB),
  };
  return {
    captured_at: new Date().toISOString(),
    snapshot_status: "locked",
    game_pk: args.game_pk,
    game_id: args.game_id,
    player_id: args.player_id,
    mlb_id: args.mlb_id,
    projection_role: "hitter",
    lineup_hash: args.lineup_hash ?? null,
    model_version: args.model_version,
    iterations: args.iterations,
    distributions,
  };
}

export function buildPitcherSnapshot(args: {
  dist: PitcherDist;
  game_id: string;
  game_pk: number | null;
  player_id: string;
  mlb_id: number | null;
  model_version: string | null;
  iterations: number;
  lineup_hash?: string | null;
}): SimSnapshot {
  const { dist } = args;
  const distributions: StoredPitcherDistributions = {
    outs: reshape(dist.outs),
    K: reshape(dist.K),
    BB: reshape(dist.BB),
    ER: reshape(dist.ER),
    H: reshape(dist.H),
  };
  return {
    captured_at: new Date().toISOString(),
    snapshot_status: "locked",
    game_pk: args.game_pk,
    game_id: args.game_id,
    player_id: args.player_id,
    mlb_id: args.mlb_id,
    projection_role: "pitcher",
    lineup_hash: args.lineup_hash ?? null,
    model_version: args.model_version,
    iterations: args.iterations,
    distributions,
  };
}

/** Game has not started — eligible for pregame snapshot capture. */
export function isPregameStatus(status: string | null | undefined): boolean {
  if (!status) return true;
  const s = String(status);
  // Anything that's not Pre-Game/Warmup/Scheduled means game is in progress
  // or terminal. Conservatively allow only known pregame states.
  return /^(Scheduled|Pre-Game|Warmup|Delayed Start|Postponed|Cancelled|Canceled|Suspended)$/i.test(s)
    && !/Postponed|Cancelled|Canceled|Suspended/i.test(s);
}

/** Lineup is locked/confirmed enough to lock a pregame snapshot. */
export function isLineupConfirmed(args: {
  lineup_status?: string | null;
  gls_status?: string | null;
  lineup_confirmed_flag?: boolean | null;
}): boolean {
  const v = (s?: string | null) => (s ?? "").toLowerCase();
  if (args.lineup_confirmed_flag === true) return true;
  if (["locked", "confirmed", "official"].includes(v(args.lineup_status))) return true;
  if (["locked", "confirmed", "official"].includes(v(args.gls_status))) return true;
  return false;
}

export function snapshotResultToDistributions(
  result: SimResult,
): { hittersByMlbId: Map<number, BatterDist>; pitcherByMlbId: Map<number, PitcherDist> } {
  const hittersByMlbId = new Map<number, BatterDist>();
  const pitcherByMlbId = new Map<number, PitcherDist>();
  for (const b of result.homeBatters) hittersByMlbId.set(b.playerId, b);
  for (const b of result.awayBatters) hittersByMlbId.set(b.playerId, b);
  if (result.homePitcher?.playerId) pitcherByMlbId.set(result.homePitcher.playerId, result.homePitcher);
  if (result.awayPitcher?.playerId) pitcherByMlbId.set(result.awayPitcher.playerId, result.awayPitcher);
  return { hittersByMlbId, pitcherByMlbId };
}
