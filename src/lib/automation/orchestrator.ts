/**
 * Diamond slate orchestrator.
 *
 * One server-side coordinator that owns the full lifecycle for today's
 * Chicago slate. Designed to run every couple of minutes via pg_cron so
 * operators do not need to run the engine by hand for normal games.
 *
 * Composed entirely of existing, well-tested primitives — orchestration
 * only, no new math:
 *   1) `runRefresh(date)` — pulls fresh lineups/starters, regenerates
 *      projections only for changed inputs, and self-heals any
 *      publication gap (eligible games without an active official run).
 *      All cutoff, eligibility, and same-hash guards live inside.
 *   2) `lockForecastsForLiveGames(date)` — atomically flips any active
 *      `published` official run to `locked` once first pitch is reached.
 *      Idempotent.
 *
 * Every cycle writes an `automation_log` row so the admin Lineup Status
 * page can show pipeline health.
 *
 * Server-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { todayInAppTz } from "@/lib/timezone";
import { runRefresh } from "@/lib/lineups/refresh.functions";
import { lockForecastsForLiveGames } from "@/lib/forecast/lifecycle";
import { runDiamondEngineForGames } from "@/lib/ingest.functions";
import { gameHasStartedOrPastStart } from "@/lib/forecast/window";
import { runPetriAutoForDate } from "@/lib/petri/run.functions";
import { ensureScheduleForDate } from "@/lib/schedule.server";
import { autoLockPregameForDate } from "@/lib/engine-beta/autolock";


import { finishAutomationLog, logAutomation } from "./log";

export type OrchestrateResult = {
  ok: boolean;
  date: string;
  yesterdayDate: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  schedule: {
    gamesFetched: number;
    gamesUpserted: number;
    inserted: number;
    updated: number;
    teamsUpserted: number;
    error?: string;
  };
  refresh: {
    changedGameIds: number;
    publicationGapGameIds: number;
    projectionsRegenerated: number;
    engineRan: boolean;
    error?: string;
  };
  recentEvents: {
    finalGames: number;
    gameEventRows: number;
    rollupRows: number;
    pitcherHitTypesSourced: boolean;
    error?: string;
  };
  preview: {
    candidateGames: number;
    projectionsRegenerated: number;
    gamesProcessed: number;
    gamesSkippedPreviewBlocked: number;
    gamesSkippedWindowClosed: number;
    engineRan: boolean;
    error?: string;
  };
  petri: {
    previewGenerated: number;
    officialGenerated: number;
    abstained: number;
    skipped: number;
    locked: number;
    error?: string;
  };
  lock: { today: number; yesterday: number; error?: string };
  engineBetaAutoLock: { processed: number; locked: number; missed: number; skipped: number; error?: string };
  error?: string;
};



function chicagoYesterday(today: string): string {
  const d = new Date(`${today}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function orchestrateDiamondSlate(
  supabaseAdmin: SupabaseClient,
  opts?: { date?: string },
): Promise<OrchestrateResult> {
  const startedAt = new Date();
  const date = opts?.date ?? todayInAppTz();
  const yesterdayDate = chicagoYesterday(date);

  const logId = await logAutomation(supabaseAdmin, {
    job: "orchestrate-slate",
    status: "started",
    slate_date: date,
    started_at: startedAt.toISOString(),
    details: { yesterdayDate },
  });

  const result: OrchestrateResult = {
    ok: true,
    date,
    yesterdayDate,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    schedule: {
      gamesFetched: 0,
      gamesUpserted: 0,
      inserted: 0,
      updated: 0,
      teamsUpserted: 0,
    },
    refresh: {
      changedGameIds: 0,
      publicationGapGameIds: 0,
      projectionsRegenerated: 0,
      engineRan: false,
    },
    recentEvents: {
      finalGames: 0,
      gameEventRows: 0,
      rollupRows: 0,
      pitcherHitTypesSourced: false,
    },
    preview: {
      candidateGames: 0,
      projectionsRegenerated: 0,
      gamesProcessed: 0,
      gamesSkippedPreviewBlocked: 0,
      gamesSkippedWindowClosed: 0,
      engineRan: false,
    },
    lock: { today: 0, yesterday: 0 },
    petri: {
      previewGenerated: 0,
      officialGenerated: 0,
      abstained: 0,
      skipped: 0,
      locked: 0,
    },
    engineBetaAutoLock: { processed: 0, locked: 0, missed: 0, skipped: 0 },
  };


  // 0) Schedule readiness — ensure public.games has rows for this slate before
  //    any lineup/probable-pitcher/player ingestion. Idempotent on mlb_game_id.
  try {
    const s = await ensureScheduleForDate(supabaseAdmin, date);
    result.schedule.gamesFetched = s.gamesFetched;
    result.schedule.gamesUpserted = s.gamesUpserted;
    result.schedule.inserted = s.inserted;
    result.schedule.updated = s.updated;
    result.schedule.teamsUpserted = s.teamsUpserted;
    if (s.error) {
      result.schedule.error = s.error;
      result.ok = false;
    } else if (s.gamesFetched > 0 && s.gamesUpserted === 0) {
      // MLB returned games but nothing stored — never silently continue.
      result.schedule.error = `MLB returned ${s.gamesFetched} games for ${date} but 0 were upserted`;
      result.ok = false;
    }
  } catch (e: any) {
    result.ok = false;
    result.schedule.error = e?.message ?? String(e);
  }

  // 1) Refresh lineups + run engine for changed/gap games (today only).
  try {
    const r = await runRefresh(date);
    result.refresh.changedGameIds = r.changedGameIds.length;
    result.refresh.publicationGapGameIds = r.publicationGapGameIds?.length ?? 0;
    result.refresh.projectionsRegenerated = r.projectionsRegenerated;
    result.refresh.engineRan = r.engineRan;
    result.recentEvents.finalGames = r.recentEvents.finalGames;
    result.recentEvents.gameEventRows = r.recentEvents.gameEventRows;
    result.recentEvents.rollupRows = r.recentEvents.rollupRows;
    result.recentEvents.pitcherHitTypesSourced = r.recentEvents.pitcherHitTypesSourced;
    if (r.recentEvents.error) result.recentEvents.error = r.recentEvents.error;
    if (!r.ok && r.error) result.refresh.error = r.error;
  } catch (e: any) {
    result.ok = false;
    result.refresh.error = e?.message ?? String(e);
  }

  // 2) Hard first-pitch lock for today + yesterday (handles late-night CT).
  try {
    const [today, yesterday] = await Promise.all([
      lockForecastsForLiveGames(supabaseAdmin, date),
      lockForecastsForLiveGames(supabaseAdmin, yesterdayDate),
    ]);
    result.lock.today = today;
    result.lock.yesterday = yesterday;
  } catch (e: any) {
    result.ok = false;
    result.lock.error = e?.message ?? String(e);
  }

  // 3) Petri v0.2 Shadow — auto preview + auto official + first-pitch lock.
  //    Fully isolated from Alpha. Failures here do NOT affect Alpha.
  try {
    const petri = await runPetriAutoForDate(supabaseAdmin, date);
    result.petri.previewGenerated = petri.preview?.generated ?? 0;
    result.petri.officialGenerated = petri.official?.generated ?? 0;
    result.petri.abstained = petri.abstained.length;
    result.petri.skipped = petri.skipped.length;
    result.petri.locked = petri.locked;
  } catch (e: any) {
    result.petri.error = e?.message ?? String(e);
  }

  // 4) Engine Beta per-game automatic pregame lock (admin-only research).
  //    Runs LAST so schedule, lineups, starters, forecasts, and shadow have
  //    all had their chance to update before we freeze truthful pregame data.
  //    Failures here do NOT affect any public Diamond behavior.
  try {
    const auto = await autoLockPregameForDate(supabaseAdmin, date);
    result.engineBetaAutoLock.processed = auto.processed;
    result.engineBetaAutoLock.locked = auto.locked;
    result.engineBetaAutoLock.missed = auto.missed;
    result.engineBetaAutoLock.skipped = auto.skipped;
    if (auto.error) result.engineBetaAutoLock.error = auto.error;
  } catch (e: any) {
    result.engineBetaAutoLock.error = e?.message ?? String(e);
  }

  const finishedAt = new Date();
  result.finishedAt = finishedAt.toISOString();
  result.durationMs = finishedAt.getTime() - startedAt.getTime();

  const status = result.ok
    ? result.refresh.engineRan ||
      result.refresh.publicationGapGameIds > 0 ||
      result.lock.today > 0 ||
      result.lock.yesterday > 0
      ? "ok"
      : "skipped"
    : result.refresh.error && result.lock.error
      ? "failed"
      : "partial";

  await finishAutomationLog(supabaseAdmin, logId, {
    status,
    finished_at: result.finishedAt,
    duration_ms: result.durationMs,
    details: {
      schedule: result.schedule,
      refresh: result.refresh,
      recentEvents: result.recentEvents,
      lock: result.lock,
      petri: result.petri,
      engineBetaAutoLock: result.engineBetaAutoLock,
    },
    error: result.schedule.error || result.refresh.error || result.recentEvents.error || result.lock.error || result.petri.error || result.engineBetaAutoLock.error || null,
  });


  return result;
}
