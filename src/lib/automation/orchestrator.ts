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
  };

  // 1) Refresh lineups + run engine for changed/gap games (today only).
  try {
    const r = await runRefresh(date);
    result.refresh.changedGameIds = r.changedGameIds.length;
    result.refresh.publicationGapGameIds = r.publicationGapGameIds?.length ?? 0;
    result.refresh.projectionsRegenerated = r.projectionsRegenerated;
    result.refresh.engineRan = r.engineRan;
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
      refresh: result.refresh,
      lock: result.lock,
      petri: result.petri,
    },
    error: result.refresh.error || result.lock.error || result.petri.error || null,
  });

  return result;
}
