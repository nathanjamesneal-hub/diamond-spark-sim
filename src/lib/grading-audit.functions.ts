/**
 * Grading & Run Audit — server functions.
 *
 * Observability + integrity layer over the existing lock/outcome pipeline.
 * Does NOT change any prediction formula, Diamond Score, or grading model.
 *
 * Grading rule enforced across this module:
 *   A game is ELIGIBLE_TO_GRADE only when
 *     (a) an immutable pregame snapshot exists whose creation timestamp is
 *         <= scheduled first pitch, AND
 *     (b) the game is Final AND official outcome data has been ingested
 *         (represented today by game_status sync from the MLB Stats API).
 *
 * Games without a valid pregame snapshot are MISSED_PREGAME and are
 * permanently excluded from official pregame calibration.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { todayInAppTz } from "@/lib/timezone";

export type GradingState =
  | "ELIGIBLE_TO_GRADE"
  | "GRADED"
  | "AWAITING_FINAL"
  | "MISSING_OUTCOMES"
  | "MISSED_PREGAME"
  | "LOCK_FAILED"
  | "NOT_READY_AT_LOCK"
  | "SCHEDULED";

export type LockStatus =
  | "auto_locked"
  | "manual_locked"
  | "missed_pregame_window"
  | "failed"
  | "not_ready";

export interface AuditGameRow {
  gameId: string;
  gamePk: number;
  matchup: string;
  firstPitchAt: string | null;
  gameStatus: string | null;
  gamePhase: "scheduled" | "live" | "final" | "postponed" | "unknown";
  lockStatus: LockStatus;
  lockReason: string | null;
  lockAttempts: string[];
  snapshotId: string | null;
  snapshotCreatedAt: string | null;
  snapshotBeforeFirstPitch: boolean | null;
  forecastVersion: string | null;
  inputsHash: string | null;
  engineStatus: string | null;
  outcomeIngestedAt: string | null;
  outcomeStatus: "not_final" | "ingested" | "missing";
  gradingState: GradingState;
  gradeable: boolean;
  blockingReasons: string[];
}

export interface StatusStack {
  timingValidCoverage: { valid: number; scheduled: number };
  resultGradeable: { gradeable: number; scheduled: number };
  calibrationEligible: { eligible: number; scheduled: number };
  integrityReviewCount: number;
  lateLockJobCount: number;
  outcomeSourceLagCount: number;
}

export interface AuditSummary {
  date: string;
  scheduled: number;
  pregameSnapshotsLocked: number;
  gradeable: number;
  awaitingFinal: number;
  missingOutcomes: number;
  missedPregameWindows: number;
  failedLocks: number;
  gradingCompleted: number;
  latestScoreRefreshAt: string | null;
  latestAutoLockAt: string | null;
  latestErrorSummary: string | null;
  statusStack: StatusStack;
}

export interface AuditPayload {
  summary: AuditSummary;
  games: AuditGameRow[];
}

function classifyPhase(status: string | null): AuditGameRow["gamePhase"] {
  if (!status) return "unknown";
  const s = status.toLowerCase();
  if (/final|game over|completed/.test(s)) return "final";
  if (/live|in progress|manager challenge/.test(s)) return "live";
  if (/postpon|suspend|cancel/.test(s)) return "postponed";
  if (/scheduled|warmup|pre.?game|delayed start/.test(s)) return "scheduled";
  return "unknown";
}

async function loadAuditForDate(admin: any, date: string): Promise<AuditPayload> {
  const [gamesRes, snapsRes, teamsRes, runsRes, logsRes, actualsRes, autolockRes, lockJobsRes, gradingJobsRes] = await Promise.all([
    admin.from("games")
      .select("id, mlb_game_id, first_pitch_at, game_status, updated_at, home_team_id, away_team_id, actual_start_at, terminal_state_source, terminal_state_resolved_at")
      .eq("date", date),
    admin.from("engine_beta_snapshots")
      .select("id, game_id, game_pk, lock_mode, lock_reason, created_at, scheduled_first_pitch, meta, data_freshness, provenance_status, engine_status, calibration_eligible, game_state_class")
      .eq("slate_date", date)
      .order("created_at", { ascending: false }),
    admin.from("teams").select("id, abbreviation, name"),
    admin.from("forecast_runs")
      .select("id, game_id, model_version, input_hash, status, locked_at, generated_at, projection_class")
      .eq("slate_date", date)
      .in("projection_class", ["official"])
      .order("generated_at", { ascending: false }),
    admin.from("automation_log")
      .select("id, job, stage, status, error, details, started_at, finished_at, game_pk")
      .eq("slate_date", date)
      .order("started_at", { ascending: false })
      .limit(500),
    admin.from("automation_log")
      .select("started_at, finished_at, status, error, details")
      .eq("job", "refresh-live-actuals")
      .eq("slate_date", date)
      .order("started_at", { ascending: false })
      .limit(1),
    admin.from("automation_log")
      .select("started_at, finished_at, status, error")
      .eq("stage", "autolock")
      .eq("slate_date", date)
      .order("started_at", { ascending: false })
      .limit(1),
    admin.from("lock_jobs")
      .select("id, game_id, status, lateness_seconds, outcome, outcome_reason, lock_at, hard_stop_at, completed_at")
      .eq("slate_date", date),
    admin.from("grading_jobs")
      .select("id, game_id, snapshot_id, status, excluded_reason, completed_at")
      .eq("slate_date", date),
  ]);

  const games = gamesRes.data ?? [];
  const snaps = snapsRes.data ?? [];
  const teams = new Map<string, any>((teamsRes.data ?? []).map((t: any) => [t.id, t]));
  const runs = runsRes.data ?? [];
  const logs = logsRes.data ?? [];

  const snapByGame = new Map<string, any>();
  for (const s of snaps) {
    // Prefer earliest automatic snapshot per game.
    const key = s.game_id;
    if (!key) continue;
    const prev = snapByGame.get(key);
    if (!prev) snapByGame.set(key, s);
  }
  const runByGame = new Map<string, any>();
  for (const r of runs) {
    if (!runByGame.has(r.game_id)) runByGame.set(r.game_id, r);
  }
  const logsByGamePk = new Map<number, any[]>();
  for (const l of logs) {
    if (l.game_pk == null) continue;
    const arr = logsByGamePk.get(Number(l.game_pk)) ?? [];
    arr.push(l);
    logsByGamePk.set(Number(l.game_pk), arr);
  }

  const rows: AuditGameRow[] = games.map((g: any) => {
    const gamePk = Number(g.mlb_game_id);
    const home = teams.get(g.home_team_id);
    const away = teams.get(g.away_team_id);
    const matchup = `${away?.abbreviation ?? "AWY"} @ ${home?.abbreviation ?? "HOM"}`;
    const phase = classifyPhase(g.game_status);
    const snap = snapByGame.get(g.id);
    const run = runByGame.get(g.id);
    const perGameLogs = logsByGamePk.get(gamePk) ?? [];

    let lockStatus: LockStatus = "not_ready";
    let lockReason: string | null = null;
    if (snap) {
      if (snap.lock_reason === "missed_pregame_window") {
        lockStatus = "missed_pregame_window";
        lockReason = "missed_pregame_window";
      } else if (snap.lock_mode === "automatic") {
        lockStatus = "auto_locked";
      } else {
        lockStatus = "manual_locked";
      }
    } else {
      const failed = perGameLogs.find((l) => l.status === "failed");
      if (failed) {
        lockStatus = "failed";
        lockReason = failed.error ?? "unknown_error";
      } else {
        lockStatus = "not_ready";
        lockReason = "outside_lock_window_or_missing_readiness";
      }
    }

    const fp = g.first_pitch_at ? Date.parse(g.first_pitch_at) : NaN;
    const snapAt = snap?.created_at ? Date.parse(snap.created_at) : NaN;
    const snapBeforeFp = Number.isFinite(fp) && Number.isFinite(snapAt) ? snapAt <= fp : null;
    const hasValidPregame = !!snap && snap.lock_reason !== "missed_pregame_window" && snapBeforeFp === true;

    const outcomeStatus: AuditGameRow["outcomeStatus"] =
      phase === "final" ? "ingested" : "not_final";
    const outcomeIngestedAt = phase === "final" ? g.updated_at ?? null : null;

    const blocking: string[] = [];
    let state: GradingState = "SCHEDULED";
    if (lockStatus === "missed_pregame_window") {
      state = "MISSED_PREGAME";
      blocking.push("no valid pregame snapshot — snapshot created after first pitch was not permitted");
    } else if (lockStatus === "failed") {
      state = "LOCK_FAILED";
      if (lockReason) blocking.push(`lock error: ${lockReason}`);
    } else if (!snap) {
      if (phase === "scheduled" || phase === "unknown") {
        state = "SCHEDULED";
        blocking.push("lock window not reached yet");
      } else {
        state = "NOT_READY_AT_LOCK";
        blocking.push("no snapshot was created before first pitch");
      }
    } else if (!hasValidPregame) {
      state = "MISSED_PREGAME";
      blocking.push("snapshot timestamp is after first pitch");
    } else if (phase !== "final") {
      state = "AWAITING_FINAL";
      blocking.push(`game phase = ${phase}`);
    } else if (outcomeStatus !== "ingested") {
      state = "MISSING_OUTCOMES";
      blocking.push("final outcomes not yet ingested");
    } else {
      state = "ELIGIBLE_TO_GRADE";
    }

    return {
      gameId: g.id,
      gamePk,
      matchup,
      firstPitchAt: g.first_pitch_at ?? null,
      gameStatus: g.game_status ?? null,
      gamePhase: phase,
      lockStatus,
      lockReason,
      lockAttempts: perGameLogs.map((l) => l.started_at).slice(0, 5),
      snapshotId: snap?.id ?? null,
      snapshotCreatedAt: snap?.created_at ?? null,
      snapshotBeforeFirstPitch: snapBeforeFp,
      forecastVersion: run?.model_version ?? null,
      inputsHash: run?.input_hash ?? snap?.meta?.inputs_hash ?? null,
      engineStatus: (snap?.meta as any)?.engine_status ?? null,
      outcomeIngestedAt,
      outcomeStatus,
      gradingState: state,
      gradeable: state === "ELIGIBLE_TO_GRADE",
      blockingReasons: blocking,
    };
  });

  const scoreRefresh = actualsRes.data?.[0] ?? null;
  const autoLock = autolockRes.data?.[0] ?? null;

  const latestError =
    logs.find((l: any) => l.status === "failed" || l.status === "timed_out") ?? null;

  const summary: AuditSummary = {
    date,
    scheduled: rows.length,
    pregameSnapshotsLocked: rows.filter((r) => r.lockStatus === "auto_locked" || r.lockStatus === "manual_locked").length,
    gradeable: rows.filter((r) => r.gradeable).length,
    awaitingFinal: rows.filter((r) => r.gradingState === "AWAITING_FINAL").length,
    missingOutcomes: rows.filter((r) => r.gradingState === "MISSING_OUTCOMES").length,
    missedPregameWindows: rows.filter((r) => r.gradingState === "MISSED_PREGAME").length,
    failedLocks: rows.filter((r) => r.gradingState === "LOCK_FAILED").length,
    gradingCompleted: rows.filter((r) => r.gradingState === "GRADED").length,
    latestScoreRefreshAt: scoreRefresh?.finished_at ?? scoreRefresh?.started_at ?? null,
    latestAutoLockAt: autoLock?.finished_at ?? autoLock?.started_at ?? null,
    latestErrorSummary: latestError
      ? `[${latestError.stage ?? latestError.job}] ${latestError.error ?? latestError.status}`
      : null,
  };

  return { summary, games: rows };
}

export const getGradingAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string } | undefined) => data ?? {})
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.date ?? todayInAppTz();
    return loadAuditForDate(supabaseAdmin, date);
  });

export interface GameAuditDetail {
  gameId: string;
  freshness: Record<string, any> | null;
  lockLogs: Array<{ started_at: string; status: string; error: string | null; details: any; stage: string | null }>;
  outcomeLogs: Array<{ started_at: string; status: string; error: string | null; details: any }>;
  currentInputsHash: string | null;
  snapshotInputsHash: string | null;
  inputsHashMatch: boolean | null;
}

export const getGameAuditDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { gameId: string; date: string }) => data)
  .handler(async ({ data, context }): Promise<GameAuditDetail> => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [gameRes, snapRes, runRes] = await Promise.all([
      supabaseAdmin.from("games").select("id, mlb_game_id").eq("id", data.gameId).maybeSingle(),
      supabaseAdmin.from("engine_beta_snapshots")
        .select("id, meta, data_freshness, created_at")
        .eq("game_id", data.gameId)
        .eq("lock_mode", "automatic")
        .maybeSingle(),
      supabaseAdmin.from("forecast_runs")
        .select("input_hash, generated_at, status, model_version")
        .eq("game_id", data.gameId)
        .eq("slate_date", data.date)
        .eq("projection_class", "official")
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const gamePk = Number(gameRes.data?.mlb_game_id ?? 0);
    const [lockLogs, outcomeLogs] = await Promise.all([
      supabaseAdmin.from("automation_log")
        .select("started_at, status, error, details, stage")
        .eq("slate_date", data.date)
        .in("stage", ["autolock", "lock"])
        .order("started_at", { ascending: false })
        .limit(20),
      supabaseAdmin.from("automation_log")
        .select("started_at, status, error, details")
        .eq("job", "refresh-live-actuals")
        .eq("slate_date", data.date)
        .order("started_at", { ascending: false })
        .limit(20),
    ]);
    const snapHash = (snapRes.data?.meta as any)?.inputs_hash ?? null;
    const curHash = runRes.data?.input_hash ?? null;
    return {
      gameId: data.gameId,
      freshness: (snapRes.data?.data_freshness as any) ?? null,
      lockLogs: (lockLogs.data ?? []) as any,
      outcomeLogs: (outcomeLogs.data ?? []) as any,
      currentInputsHash: curHash,
      snapshotInputsHash: snapHash,
      inputsHashMatch: snapHash && curHash ? snapHash === curHash : null,
    };
  });

export const retryScoreRefresh = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string } | undefined) => data ?? {})
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { refreshLiveActuals } = await import("@/lib/automation/live-actuals");
    return refreshLiveActuals(supabaseAdmin, { date: data.date });
  });

export const retryAutoLock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string } | undefined) => data ?? {})
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { autoLockPregameForDate } = await import("@/lib/engine-beta/autolock");
    return autoLockPregameForDate(supabaseAdmin as any, data.date);
  });
