/**
 * Pure staged-projection helpers.
 *
 * Derives:
 *   - projection_stage : early | updated | lineup_confirmed | final_pregame
 *   - game_lifecycle_status : awaiting_probable_pitchers | ready_for_early_projection
 *                              | queued | current | awaiting_confirmed_lineup
 *                              | lineup_change_detected | market_refresh_only
 *                              | game_started | postponed | cancelled | failed
 *   - change_reason : short human-readable diff summary
 *
 * No DB access; safe to unit-test.
 */

export type ProjectionStage =
  | "early"
  | "updated"
  | "lineup_confirmed"
  | "final_pregame";

export type GameLifecycleStatus =
  | "awaiting_probable_pitchers"
  | "ready_for_early_projection"
  | "queued"
  | "running"
  | "current"
  | "inputs_unchanged"
  | "stale"
  | "awaiting_confirmed_lineup"
  | "lineup_change_detected"
  | "market_refresh_only"
  | "failed"
  | "game_started"
  | "postponed"
  | "cancelled";

export type StageInputs = {
  startersReady: boolean;
  lineupsProjected: boolean;
  lineupsConfirmed: boolean;
  /** minutes until scheduled first pitch (may be negative if game has started). */
  minutesToFirstPitch: number | null;
  /** whether a prior current projection exists for this game. */
  hadPriorCurrent: boolean;
};

/** Cutoff (minutes before first pitch) after which a projection is "final pregame". */
export const FINAL_PREGAME_CUTOFF_MIN = 10;

export function deriveProjectionStage(x: StageInputs): ProjectionStage | null {
  if (!x.startersReady) return null;

  // Inside the final-pregame cutoff and lineups confirmed → this is THE final snapshot.
  const inFinalWindow =
    x.minutesToFirstPitch != null &&
    x.minutesToFirstPitch <= FINAL_PREGAME_CUTOFF_MIN &&
    x.minutesToFirstPitch >= 0;

  if (inFinalWindow && x.lineupsConfirmed) return "final_pregame";
  if (x.lineupsConfirmed) return "lineup_confirmed";
  if (x.hadPriorCurrent) return "updated";
  return "early";
}

export type ReadinessInputs = {
  gameStatus: string | null;
  startersReady: boolean;
  lineupsProjected: boolean;
  lineupsConfirmed: boolean;
  minutesToFirstPitch: number | null;
};

export function deriveGameLifecycleStatus(x: ReadinessInputs): {
  status: GameLifecycleStatus;
  waitingReason: string | null;
  nextAction: string;
} {
  const gs = (x.gameStatus ?? "").toLowerCase();
  if (gs.includes("postponed")) {
    return { status: "postponed", waitingReason: "game postponed by MLB", nextAction: "await reschedule" };
  }
  if (gs.includes("cancel")) {
    return { status: "cancelled", waitingReason: "game cancelled", nextAction: "exclude from slate" };
  }
  if (
    gs.includes("in progress") ||
    gs.includes("live") ||
    gs.includes("final") ||
    gs.includes("game over")
  ) {
    return { status: "game_started", waitingReason: "first pitch reached", nextAction: "no further pregame projections" };
  }
  if (!x.startersReady) {
    return {
      status: "awaiting_probable_pitchers",
      waitingReason: "probable pitchers not confirmed",
      nextAction: "poll starting_pitchers on next refresh",
    };
  }
  if (!x.lineupsProjected) {
    return {
      status: "ready_for_early_projection",
      waitingReason: null,
      nextAction: "enqueue early projection with expected batting order",
    };
  }
  if (!x.lineupsConfirmed) {
    return {
      status: "awaiting_confirmed_lineup",
      waitingReason: "expected lineup only; awaiting confirmed lineup card",
      nextAction: "poll lineups; enqueue lineup_confirmed on confirmation",
    };
  }
  const inFinalWindow =
    x.minutesToFirstPitch != null &&
    x.minutesToFirstPitch <= FINAL_PREGAME_CUTOFF_MIN &&
    x.minutesToFirstPitch >= 0;
  return {
    status: inFinalWindow ? "current" : "current",
    waitingReason: null,
    nextAction: inFinalWindow ? "emit final_pregame snapshot" : "hold current; refresh on input change",
  };
}

export type ChangeDiff = {
  prevHash: string | null;
  nextHash: string;
  prevInputs?: unknown;
  nextInputs?: unknown;
  /** Free-form flags computed by the planner. */
  flags?: Partial<Record<
    | "pitcher_change"
    | "lineup_change"
    | "batting_order_change"
    | "lineup_confirmed"
    | "weather_change"
    | "park_change"
    | "model_version_change"
    | "first_projection",
    boolean
  >>;
};

export function summarizeChangeReason(d: ChangeDiff): string {
  if (d.prevHash === null) return "first projection for this game";
  const flags = d.flags ?? {};
  const parts: string[] = [];
  if (flags.pitcher_change) parts.push("probable pitcher changed");
  if (flags.lineup_confirmed) parts.push("lineup confirmed");
  if (flags.batting_order_change) parts.push("batting order changed");
  if (flags.lineup_change) parts.push("lineup roster changed");
  if (flags.weather_change) parts.push("weather bucket changed");
  if (flags.park_change) parts.push("ballpark changed");
  if (flags.model_version_change) parts.push("model version changed");
  if (parts.length === 0) return `inputs_hash changed (${d.prevHash.slice(0, 8)} → ${d.nextHash.slice(0, 8)})`;
  return parts.join("; ");
}
