/**
 * Diamond Engine Beta — per-game automatic pregame lock.
 *
 * Called from the production orchestrator (`orchestrateDiamondSlate`) after
 * schedule, lineup, starter, forecast, and shadow processing have all had
 * a chance to run for the current slate. Iterates today's games and, for
 * each one that:
 *
 *   - has a schedule row with a scheduled first pitch
 *   - is within `[firstPitch - lockLeadMinutes, firstPitch)` (default 2 min)
 *   - has NOT begun according to MLB game_status
 *   - has at least one baseline forecast row in any Beta category
 *   - has no existing `automatic` snapshot yet
 *
 * ... writes an immutable `engine_beta_snapshots` header (`lock_mode='automatic'`)
 * plus per-category rows in `engine_beta_snapshot_rows`.
 *
 * If the pregame window was missed (first pitch is in the past AND no auto
 * snapshot exists) the game is recorded with `lock_mode='automatic'`,
 * `lock_reason='missed_pregame_window'`, and NO rows — a durable audit
 * record that this game will never receive a valid pregame snapshot.
 *
 * Never overwrites, never mutates prior snapshots.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { todayInAppTz } from "@/lib/timezone";
import { ENGINE_BETA_WEIGHTS } from "./score";
import { ENGINE_BETA_CATEGORIES } from "./categories";
import { computeGameSnapshotRows } from "./compute";

export const DEFAULT_LOCK_LEAD_MINUTES = 2;
export const DEFAULT_MISSED_GRACE_MINUTES = 30; // record 'missed' up to 30 min after first pitch

export type GameLockOutcome =
  | { gameId: string; gamePk: number; status: "locked"; snapshotId: string; rows: number; mode: "automatic"; reason: null; firstPitchAt: string | null }
  | { gameId: string; gamePk: number; status: "missed"; snapshotId: string; rows: 0; mode: "automatic"; reason: string; firstPitchAt: string | null }
  | { gameId: string; gamePk: number; status: "skipped"; snapshotId: null; rows: 0; mode: "automatic"; reason: string; firstPitchAt: string | null };

export type AutoLockResult = {
  date: string;
  now: string;
  lockLeadMinutes: number;
  processed: number;
  locked: number;
  missed: number;
  skipped: number;
  outcomes: GameLockOutcome[];
  error?: string;
};

const LIVE_STATUS_RX = /live|in progress|final|game over|completed|postponed|suspended|delayed start/i;

function gameHasStarted(game: any, nowMs: number): boolean {
  if (game.game_status && LIVE_STATUS_RX.test(String(game.game_status))) return true;
  const fp = game.first_pitch_at ? Date.parse(game.first_pitch_at) : NaN;
  return Number.isFinite(fp) && fp <= nowMs;
}

/**
 * Compute a compact freshness record for the game — captures how recent
 * the truthful data was when the snapshot was created.
 */
async function collectFreshness(admin: any, date: string, gameId: string, gamePk: number) {
  const [runs, lineups, starters, shadow] = await Promise.all([
    admin.from("forecast_runs")
      .select("id, status, generated_at, locked_at, model_version")
      .eq("game_id", gameId).eq("slate_date", date).order("generated_at", { ascending: false }).limit(1),
    admin.from("lineups")
      .select("game_id, updated_at, lineup_status, confirmed")
      .eq("game_id", gameId).order("updated_at", { ascending: false }).limit(1),
    admin.from("starting_pitchers")
      .select("game_id, updated_at, confirmed")
      .eq("game_id", gameId).order("updated_at", { ascending: false }).limit(1),
    admin.from("monte_carlo_form_shadow_runs")
      .select("id, created_at").eq("game_id", gameId).eq("slate_date", date)
      .order("created_at", { ascending: false }).limit(1),
  ]);
  const run = runs.data?.[0] ?? null;
  const lineup = lineups.data?.[0] ?? null;
  const starter = starters.data?.[0] ?? null;
  const shadowRun = shadow.data?.[0] ?? null;
  return {
    forecast: run ? { runId: run.id, status: run.status, generatedAt: run.generated_at, lockedAt: run.locked_at, modelVersion: run.model_version } : null,
    lineup: lineup ? { updatedAt: lineup.updated_at, status: lineup.lineup_status, confirmed: lineup.confirmed } : null,
    starter: starter ? { updatedAt: starter.updated_at, confirmed: starter.confirmed } : null,
    shadow: shadowRun ? { runId: shadowRun.id, createdAt: shadowRun.created_at } : null,
    slateDate: date,
    gamePk,
  };
}

/**
 * Attempt one game. Handles all eligibility gates + safe idempotency.
 */
export async function tryAutoLockGame(
  admin: any,
  game: { id: string; mlb_game_id: number; first_pitch_at: string | null; game_status: string | null; date: string },
  now: Date,
  lockLeadMinutes: number,
  missedGraceMinutes: number,
): Promise<GameLockOutcome> {
  const gameId = game.id;
  const gamePk = Number(game.mlb_game_id);
  const firstPitchAt = game.first_pitch_at;
  const nowMs = now.getTime();

  // Existing automatic snapshot? — idempotent skip.
  const { data: existing } = await admin
    .from("engine_beta_snapshots")
    .select("id, lock_mode, lock_reason, created_at")
    .eq("game_id", gameId)
    .eq("lock_mode", "automatic")
    .limit(1);
  if (existing && existing.length > 0) {
    const e = existing[0];
    return { gameId, gamePk, status: "skipped", snapshotId: null, rows: 0, mode: "automatic", reason: e.lock_reason ? `already_${e.lock_reason}` : "already_locked", firstPitchAt };
  }

  // No first pitch known — cannot pregame-lock.
  if (!firstPitchAt) {
    return { gameId, gamePk, status: "skipped", snapshotId: null, rows: 0, mode: "automatic", reason: "no_first_pitch_time", firstPitchAt };
  }
  const fpMs = Date.parse(firstPitchAt);
  const leadMs = lockLeadMinutes * 60_000;
  const graceMs = missedGraceMinutes * 60_000;

  // Game already live/final → cannot create a valid pregame lock.
  if (gameHasStarted(game, nowMs)) {
    // Record a durable 'missed' marker so the UI can explain it, but only
    // within the grace window and only once.
    if (nowMs - fpMs > graceMs) {
      return { gameId, gamePk, status: "skipped", snapshotId: null, rows: 0, mode: "automatic", reason: "game_started_beyond_grace", firstPitchAt };
    }
    const { data: snap, error } = await admin
      .from("engine_beta_snapshots")
      .insert({
        slate_date: game.date,
        game_id: gameId,
        game_pk: gamePk,
        scheduled_first_pitch: firstPitchAt,
        lock_mode: "automatic",
        lock_reason: "missed_pregame_window",
        notes: null,
        meta: { weights: ENGINE_BETA_WEIGHTS, version: 1, missed: true, reason: "Game started before automatic lock window fired" },
        data_freshness: await collectFreshness(admin, game.date, gameId, gamePk),
      })
      .select("id")
      .single();
    if (error) {
      // Unique violation → someone raced us. Treat as skipped-already-exists.
      if (String(error.code) === "23505") {
        return { gameId, gamePk, status: "skipped", snapshotId: null, rows: 0, mode: "automatic", reason: "already_locked", firstPitchAt };
      }
      throw new Error(error.message);
    }
    return { gameId, gamePk, status: "missed", snapshotId: snap.id, rows: 0, mode: "automatic", reason: "missed_pregame_window", firstPitchAt };
  }

  // Too early — outside the lock window.
  if (fpMs - nowMs > leadMs) {
    return { gameId, gamePk, status: "skipped", snapshotId: null, rows: 0, mode: "automatic", reason: "outside_lock_window", firstPitchAt };
  }

  // Inside window: build snapshot rows for the game across every category.
  const { rowsByCategory, gameRowCount } = await computeGameSnapshotRows(admin, game.date, gameId);
  if (gameRowCount === 0) {
    return { gameId, gamePk, status: "skipped", snapshotId: null, rows: 0, mode: "automatic", reason: "no_eligible_rows", firstPitchAt };
  }

  // Insert snapshot header (unique per game for automatic mode).
  const freshness = await collectFreshness(admin, game.date, gameId, gamePk);
  const { data: snap, error: snapErr } = await admin
    .from("engine_beta_snapshots")
    .insert({
      slate_date: game.date,
      game_id: gameId,
      game_pk: gamePk,
      scheduled_first_pitch: firstPitchAt,
      lock_mode: "automatic",
      lock_reason: null,
      notes: null,
      meta: { weights: ENGINE_BETA_WEIGHTS, version: 1, lockLeadMinutes, generatedAt: new Date().toISOString() },
      data_freshness: freshness,
    })
    .select("id")
    .single();
  if (snapErr) {
    if (String(snapErr.code) === "23505") {
      return { gameId, gamePk, status: "skipped", snapshotId: null, rows: 0, mode: "automatic", reason: "already_locked", firstPitchAt };
    }
    throw new Error(snapErr.message);
  }
  const snapshotId = snap.id as string;

  // Insert per-category rows.
  const inserts: any[] = [];
  for (const c of ENGINE_BETA_CATEGORIES) {
    for (const row of rowsByCategory[c.key] ?? []) inserts.push({ ...row, snapshot_id: snapshotId });
  }
  if (inserts.length) {
    const { error } = await admin.from("engine_beta_snapshot_rows").insert(inserts);
    if (error) {
      // Header exists but rows failed → surface the error; header is a
      // durable audit entry. Do NOT delete it; a later run will not retry
      // because the header exists, but this is a hard error we want to see.
      throw new Error(`snapshot rows insert failed: ${error.message}`);
    }
  }

  return { gameId, gamePk, status: "locked", snapshotId, rows: inserts.length, mode: "automatic", reason: null, firstPitchAt };
}

/**
 * Iterate every scheduled game for `date` and try to auto-lock each one.
 * Safe to call on every orchestrator cycle — every failure mode short-circuits
 * cleanly.
 */
export async function autoLockPregameForDate(
  admin: SupabaseClient,
  date: string = todayInAppTz(),
  opts?: { lockLeadMinutes?: number; missedGraceMinutes?: number },
): Promise<AutoLockResult> {
  const lockLeadMinutes = opts?.lockLeadMinutes ?? DEFAULT_LOCK_LEAD_MINUTES;
  const missedGraceMinutes = opts?.missedGraceMinutes ?? DEFAULT_MISSED_GRACE_MINUTES;
  const now = new Date();
  const result: AutoLockResult = {
    date, now: now.toISOString(), lockLeadMinutes,
    processed: 0, locked: 0, missed: 0, skipped: 0, outcomes: [],
  };

  try {
    const { data: games, error } = await (admin as any)
      .from("games")
      .select("id, mlb_game_id, first_pitch_at, game_status, date")
      .eq("date", date);
    if (error) throw new Error(error.message);
    const gs = games ?? [];
    for (const g of gs) {
      result.processed += 1;
      try {
        const outcome = await tryAutoLockGame(admin, g, now, lockLeadMinutes, missedGraceMinutes);
        result.outcomes.push(outcome);
        if (outcome.status === "locked") result.locked += 1;
        else if (outcome.status === "missed") result.missed += 1;
        else result.skipped += 1;
      } catch (e: any) {
        result.skipped += 1;
        result.outcomes.push({
          gameId: g.id, gamePk: Number(g.mlb_game_id), status: "skipped", snapshotId: null, rows: 0, mode: "automatic",
          reason: `error:${e?.message ?? String(e)}`, firstPitchAt: g.first_pitch_at ?? null,
        });
      }
    }
  } catch (e: any) {
    result.error = e?.message ?? String(e);
  }

  return result;
}
