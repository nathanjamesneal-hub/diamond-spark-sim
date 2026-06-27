/**
 * Forecast Window Guard — single source of truth for the first-pitch cutoff.
 *
 * Hard rule: once a game is live, in progress, final, suspended after start,
 * or otherwise past first pitch, Diamond must NEVER create, refresh, rerun,
 * reissue, or modify any player projection for that game.
 *
 * Every write path (`publishForecastIfEligible`, `runDiamondEngineForGames`,
 * `runDailyPipeline`, `forceRunDiamondEngine`, `publishOfficialForecast`,
 * `runRefresh`, `runEngineForGame`, `refreshLineupsForGame`) MUST consult
 * `assertForecastWindowOpen` before writing.
 *
 * The window is OPEN for: Scheduled, Pre-Game, Warmup, Postponed (before
 * start), "Delayed Start: Rain".
 *
 * The window is CLOSED for: Live / In Progress / Final / Game Over /
 * Completed / Manager Challenge / Suspended / Delayed (after first pitch) /
 * anything where the scheduled first-pitch wall-clock has already passed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type WindowOpenResult = {
  open: true;
  game: GameRow;
};

export type WindowClosedResult = {
  open: false;
  game: GameRow | null;
  gamePk: number;
  gameStatus: string | null;
  reason: string;
};

export type WindowResult = WindowOpenResult | WindowClosedResult;

type GameRow = {
  id: string;
  mlb_game_id: number;
  date: string;
  game_status: string | null;
  first_pitch_at: string | null;
};

/**
 * Pure status check — no DB I/O. Identical semantics to the historical
 * `gameHasStartedOrPastStart` (lifecycle.ts) and `gameHasStarted`
 * (eligibility.ts); those modules re-export from this file.
 */
export function gameHasStartedOrPastStart(
  status: string | null | undefined,
  firstPitchAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const s = (status ?? "").toLowerCase();
  if (
    s.includes("in progress") ||
    s.includes("live") ||
    s.includes("final") ||
    s.includes("game over") ||
    s.includes("completed") ||
    s.includes("manager challenge") ||
    s.includes("suspended") ||
    // "Delayed Start: Rain" stays open; any other "Delayed" means after first pitch.
    (s.includes("delayed") && !s.includes("delayed start"))
  ) {
    return true;
  }
  if (firstPitchAt) {
    const t = Date.parse(firstPitchAt);
    if (Number.isFinite(t) && now >= t) return true;
  }
  return false;
}

/** Emit the canonical structured log line for a blocked write attempt. */
export function logWindowClosed(args: {
  gamePk: number;
  gameStatus: string | null;
  action: string;
  reason?: string;
  actor?: string | null;
}): void {
  // eslint-disable-next-line no-console
  console.log("[forecast.window]", JSON.stringify({
    gamePk: args.gamePk,
    gameStatus: args.gameStatus,
    action: args.action,
    decision: "forecast_window_closed",
    reason: args.reason ?? "game has started or first pitch passed",
    actor: args.actor ?? null,
  }));
}

/**
 * Server-side guard. Loads authoritative game state from the DB and
 * decides whether the forecast window is open. Callers that already have
 * the game row in memory should use {@link gameHasStartedOrPastStart}
 * directly + {@link logWindowClosed}; this helper exists for single-game
 * write entries (admin reissue, per-game engine, lifecycle, etc.).
 */
export async function assertForecastWindowOpen(
  admin: SupabaseClient<any>,
  gamePk: number,
  action: string,
  actor: string | null = null,
): Promise<WindowResult> {
  const { data } = await admin
    .from("games")
    .select("id, mlb_game_id, date, game_status, first_pitch_at")
    .eq("mlb_game_id", gamePk)
    .maybeSingle();
  const game = (data as GameRow | null) ?? null;
  if (!game) {
    const reason = "game not found";
    logWindowClosed({ gamePk, gameStatus: null, action, reason, actor });
    return { open: false, game: null, gamePk, gameStatus: null, reason };
  }
  if (gameHasStartedOrPastStart(game.game_status, game.first_pitch_at)) {
    logWindowClosed({
      gamePk,
      gameStatus: game.game_status,
      action,
      actor,
    });
    return {
      open: false,
      game,
      gamePk,
      gameStatus: game.game_status,
      reason: "game has started or first pitch passed",
    };
  }
  return { open: true, game };
}

/**
 * Batch variant for write paths that operate on a slate. Takes the
 * already-loaded `games` rows so we never hit the DB twice. Returns the
 * partitioned set and emits one log line per blocked game.
 *
 * Use this from `runDiamondEngineForGames`, `runRefresh`, and
 * `runDailyPipeline` — anywhere we have N games and want to drop the
 * closed ones before invoking the engine.
 */
export function partitionOpenGames<
  G extends { id: string; mlb_game_id: number | null; game_status: string | null; first_pitch_at?: string | null },
>(
  games: G[],
  action: string,
  actor: string | null = null,
): { open: G[]; blocked: Array<{ game: G; gameStatus: string | null }> } {
  const open: G[] = [];
  const blocked: Array<{ game: G; gameStatus: string | null }> = [];
  for (const g of games) {
    if (gameHasStartedOrPastStart(g.game_status, g.first_pitch_at ?? null)) {
      blocked.push({ game: g, gameStatus: g.game_status });
      if (g.mlb_game_id != null) {
        logWindowClosed({
          gamePk: g.mlb_game_id,
          gameStatus: g.game_status,
          action,
          actor,
        });
      }
    } else {
      open.push(g);
    }
  }
  return { open, blocked };
}

/** Standard structured rejection result returned by guarded write paths. */
export type ForecastWindowClosedResult = {
  ok: false;
  decision: "forecast_window_closed";
  gamePk: number;
  gameStatus: string | null;
  reason: string;
};
