/**
 * Projection Refresh Planner.
 *
 * Wraps the existing sim-queue enqueue and adds three responsibilities:
 *
 *   1. Persist per-game `projection_refresh_state` so the scheduler can be
 *      observed without any UI open.
 *   2. Compute a `projection_stage` for every enqueued job so the badge in
 *      the UI ("Early Projection", "Confirmed Lineup", …) matches what the
 *      pipeline actually did.
 *   3. Detect why the inputs_hash changed vs the previous current job and
 *      write a plain-English `change_reason` on the sim_jobs row.
 *
 * Idempotent by design — the existing UNIQUE(game_id, model_version,
 * inputs_hash, tier, label) index on sim_jobs prevents duplicate enqueues.
 *
 * Never runs the Monte Carlo engine and never touches ranking, grading, or
 * recommendation math.
 *
 * Server-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { enqueueSimJobsForDate, SIM_MODEL_VERSION } from "@/lib/sim-queue/enqueue.server";
import {
  deriveProjectionStage,
  deriveGameLifecycleStatus,
  summarizeChangeReason,
  type ProjectionStage,
  type ChangeDiff,
} from "./stage";

export type PlannerPerGame = {
  gameId: string;
  gamePk: number;
  firstPitchAt: string | null;
  inputsHash: string;
  projectionStage: ProjectionStage | null;
  gameLifecycleStatus: string;
  waitingReason: string | null;
  nextAction: string;
  hashChanged: boolean;
  changeReason: string | null;
  enqueued: Array<{ tier: string; label: string; jobId: string | null; noop: boolean; reason?: string }>;
  skippedReason?: string;
};

export type PlannerResult = {
  slateDate: string;
  startedAt: string;
  finishedAt: string;
  gamesConsidered: number;
  rowsEnqueued: number;
  earlyProjectionsCreated: number;
  lineupChangesDetected: number;
  unchangedGames: number;
  perGame: PlannerPerGame[];
  error?: string;
};

type PriorJob = {
  id: string;
  inputs_hash: string;
  projection_stage: string | null;
  seed_meta: Record<string, unknown> | null;
};

function minutesUntil(firstPitchAt: string | null): number | null {
  if (!firstPitchAt) return null;
  return Math.round((new Date(firstPitchAt).getTime() - Date.now()) / 60_000);
}

export async function runProjectionRefreshPlanner(
  supabaseAdmin: SupabaseClient,
  slateDate: string,
): Promise<PlannerResult> {
  const startedAt = new Date().toISOString();
  const result: PlannerResult = {
    slateDate,
    startedAt,
    finishedAt: startedAt,
    gamesConsidered: 0,
    rowsEnqueued: 0,
    earlyProjectionsCreated: 0,
    lineupChangesDetected: 0,
    unchangedGames: 0,
    perGame: [],
  };

  // Delegate the actual enqueue + inputs-hash computation to the existing
  // primitive. We layer stage + state bookkeeping on top of its per-game report.
  const enq = await enqueueSimJobsForDate(supabaseAdmin, slateDate);
  result.gamesConsidered = enq.gamesConsidered;
  result.rowsEnqueued = enq.rowsEnqueued;
  if (enq.error) result.error = enq.error;

  // Pull the current sim_jobs for these games (latest per game+model_version)
  // so we can detect a hash change and stamp change_reason.
  const gameIds = enq.perGame.map((p) => p.gameId);
  const priorByGame = new Map<string, PriorJob>();
  if (gameIds.length > 0) {
    const { data: prior } = await supabaseAdmin
      .from("sim_jobs")
      .select("id, game_id, inputs_hash, projection_stage, seed_meta, completed_at, queued_at")
      .in("game_id", gameIds)
      .eq("model_version", SIM_MODEL_VERSION)
      .in("status", ["completed", "running", "queued"])
      .order("queued_at", { ascending: false });
    for (const row of (prior ?? []) as any[]) {
      if (!priorByGame.has(row.game_id)) {
        priorByGame.set(row.game_id, {
          id: row.id,
          inputs_hash: row.inputs_hash,
          projection_stage: row.projection_stage,
          seed_meta: row.seed_meta,
        });
      }
    }
  }

  for (const g of enq.perGame) {
    const minutes = minutesUntil(g.firstPitchAt);
    const prior = priorByGame.get(g.gameId) ?? null;
    const hadPriorCurrent = !!prior;
    const stage = deriveProjectionStage({
      startersReady: g.startersReady,
      lineupsProjected: g.lineupsProjected,
      lineupsConfirmed: g.lineupsConfirmed,
      minutesToFirstPitch: minutes,
      hadPriorCurrent,
    });

    const lifecycle = deriveGameLifecycleStatus({
      gameStatus: null, // enqueue already filtered non-pregame games; leave null here.
      startersReady: g.startersReady,
      lineupsProjected: g.lineupsProjected,
      lineupsConfirmed: g.lineupsConfirmed,
      minutesToFirstPitch: minutes,
    });

    const hashChanged = prior ? prior.inputs_hash !== g.inputsHash : true;
    const changeReason = hashChanged
      ? summarizeChangeReason({
          prevHash: prior?.inputs_hash ?? null,
          nextHash: g.inputsHash,
          flags: {
            first_projection: !prior,
            lineup_confirmed: g.lineupsConfirmed,
          },
        } as ChangeDiff)
      : null;

    if (!hashChanged) result.unchangedGames += 1;
    if (hashChanged && prior) result.lineupChangesDetected += 1;

    const anyEnqueued = g.enqueued.some((e) => !e.noop);
    if (anyEnqueued && stage === "early") result.earlyProjectionsCreated += 1;

    // Stamp projection_stage + change_reason onto the freshly inserted job(s).
    const insertedIds = g.enqueued
      .filter((e) => !e.noop && e.jobId)
      .map((e) => e.jobId as string);
    if (insertedIds.length && stage) {
      await supabaseAdmin
        .from("sim_jobs")
        .update({
          projection_stage: stage,
          change_reason: changeReason,
          input_effective_time: new Date().toISOString(),
        })
        .in("id", insertedIds);
    }

    // Upsert per-game scheduler state.
    const finalStatus = anyEnqueued ? "queued" : hashChanged ? lifecycle.status : "inputs_unchanged";
    await supabaseAdmin.from("projection_refresh_state").upsert(
      {
        slate_date: slateDate,
        game_id: g.gameId,
        game_pk: g.gamePk || null,
        scheduled_first_pitch_at: g.firstPitchAt,
        current_projection_stage: stage,
        game_lifecycle_status: finalStatus,
        latest_inputs_hash: g.inputsHash,
        latest_sim_job_id: insertedIds[0] ?? prior?.id ?? null,
        pitcher_status: g.startersReady ? "ready" : "awaiting_probable",
        lineup_status: g.lineupsConfirmed
          ? "confirmed"
          : g.lineupsProjected
            ? "projected"
            : "unknown",
        waiting_reason: lifecycle.waitingReason,
        next_action: lifecycle.nextAction,
        last_checked_at: new Date().toISOString(),
        last_model_update_at: anyEnqueued ? new Date().toISOString() : undefined,
        change_reason: changeReason,
      },
      { onConflict: "slate_date,game_id" },
    );

    result.perGame.push({
      gameId: g.gameId,
      gamePk: g.gamePk,
      firstPitchAt: g.firstPitchAt,
      inputsHash: g.inputsHash,
      projectionStage: stage,
      gameLifecycleStatus: finalStatus,
      waitingReason: lifecycle.waitingReason,
      nextAction: lifecycle.nextAction,
      hashChanged,
      changeReason,
      enqueued: g.enqueued,
      skippedReason: g.skippedReason,
    });
  }

  result.finishedAt = new Date().toISOString();
  return result;
}
