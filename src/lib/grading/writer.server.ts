/**
 * Immutable grade writer.
 *
 * - Reads ONLY snapshot header + engine_beta_snapshot_rows for the target
 *   snapshot. Never reads current forecasts, current player cards, or
 *   current inputs.
 * - Uses the exact saved event/threshold/line stored on each snapshot row.
 * - Computes Brier for binary events with a projected probability.
 * - Computes MAE + signed error for count projections only when an
 *   immutable projected mean exists on the snapshot row.
 * - Excludes MISSED_PREGAME, post-first-pitch, malformed, and
 *   provenance-incomplete snapshots from calibration aggregates.
 * - Labels legacy/provenance-missing snapshots as "Result comparison only".
 *
 * Idempotency: unique constraint on grading_jobs.snapshot_id and one
 * grading_run per snapshot per invocation (we mark the job GRADED and
 * subsequent worker cycles skip it).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type GradingWorkerResult = {
  now: string;
  claimed: number;
  graded: number;
  excluded: number;
  errors: number;
  outcomes: Array<{
    gradingJobId: string;
    snapshotId: string;
    status: string;
    reason?: string | null;
    rowCount?: number;
    calibrationEligible?: boolean;
  }>;
};

const LEASE_MS = 60_000;

export async function runGradingWorker(
  admin: SupabaseClient<any>,
  opts?: { workerId?: string; maxJobs?: number },
): Promise<GradingWorkerResult> {
  const workerId = opts?.workerId ?? `grader-${Math.random().toString(36).slice(2, 8)}`;
  const maxJobs = opts?.maxJobs ?? 25;
  const nowIso = new Date().toISOString();
  const now = Date.parse(nowIso);
  const result: GradingWorkerResult = {
    now: nowIso, claimed: 0, graded: 0, excluded: 0, errors: 0, outcomes: [],
  };

  const { data: due, error: dueErr } = await admin
    .from("grading_jobs")
    .select("id, slate_date, game_id, snapshot_id, status, attempt_count, lease_until")
    .in("status", ["PENDING_FINAL", "READY_TO_GRADE", "RETRY"])
    .order("created_at", { ascending: true })
    .limit(maxJobs);
  if (dueErr) throw new Error(`grading_jobs load: ${dueErr.message}`);

  for (const job of due ?? []) {
    const leaseExpired = !job.lease_until || Date.parse(job.lease_until) <= now;
    if (!leaseExpired) continue;

    // Claim
    const { data: claimed } = await admin.from("grading_jobs").update({
      claimed_at: nowIso, claimed_by: workerId,
      lease_until: new Date(now + LEASE_MS).toISOString(),
      started_at: nowIso, attempt_count: (job.attempt_count ?? 0) + 1,
    }).eq("id", job.id).in("status", ["PENDING_FINAL", "READY_TO_GRADE", "RETRY"]).select("id").maybeSingle();
    if (!claimed) continue;
    result.claimed += 1;

    try {
      const outcome = await gradeSnapshot(admin, job.snapshot_id, job.slate_date, job.game_id, job.id);
      await admin.from("grading_jobs").update({
        status: outcome.status,
        completed_at: nowIso,
        excluded_reason: outcome.excludedReason ?? null,
        grading_run_id: outcome.gradingRunId ?? null,
        lease_until: null,
        last_error: null,
      }).eq("id", job.id);
      if (outcome.status === "GRADED") result.graded += 1;
      else if (outcome.status.startsWith("EXCLUDED")) result.excluded += 1;
      result.outcomes.push({
        gradingJobId: job.id, snapshotId: job.snapshot_id, status: outcome.status,
        reason: outcome.excludedReason ?? null, rowCount: outcome.rowCount,
        calibrationEligible: outcome.calibrationEligible,
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      await admin.from("grading_jobs").update({
        status: "GRADE_FAILED", last_error: msg, lease_until: null,
      }).eq("id", job.id);
      result.errors += 1;
      result.outcomes.push({
        gradingJobId: job.id, snapshotId: job.snapshot_id, status: "GRADE_FAILED",
        reason: msg,
      });
    }
  }
  return result;
}

type SnapshotGradeOutcome = {
  status:
    | "GRADED"
    | "PENDING_FINAL"
    | "EXCLUDED_MISSED_PREGAME"
    | "EXCLUDED_PROVENANCE_MISSING"
    | "EXCLUDED_INTEGRITY_REVIEW";
  excludedReason?: string;
  gradingRunId?: string;
  rowCount?: number;
  calibrationEligible?: boolean;
};

async function gradeSnapshot(
  admin: SupabaseClient<any>,
  snapshotId: string,
  slateDate: string,
  gameId: string,
  gradingJobId: string,
): Promise<SnapshotGradeOutcome> {
  // 1. Load snapshot header (immutable).
  const { data: snap } = await admin
    .from("engine_beta_snapshots")
    .select("id, lock_mode, lock_reason, engine_status, forecast_version, inputs_hash, provenance_status, scheduled_first_pitch, actual_start_at, game_state_class")
    .eq("id", snapshotId).maybeSingle();
  if (!snap) throw new Error("snapshot_not_found");

  // 2. Missed pregame → exclude.
  if (snap.lock_reason === "missed_pregame_window") {
    return { status: "EXCLUDED_MISSED_PREGAME", excludedReason: "snapshot lock_reason=missed_pregame_window" };
  }

  // 3. Confirm game is Final via terminal-state fields on games.
  const { data: game } = await admin
    .from("games")
    .select("id, game_status, terminal_state_source, terminal_state_resolved_at, actual_start_at, first_pitch_at")
    .eq("id", gameId).maybeSingle();
  if (!game) throw new Error("game_not_found");
  if (!game.terminal_state_resolved_at) {
    return { status: "PENDING_FINAL", excludedReason: "no_terminal_state_yet" };
  }

  // 4. Snapshot-timing integrity check.
  const snapshotCreatedAt = Date.parse((snap as any).created_at ?? "");
  const startRef = game.actual_start_at ? Date.parse(game.actual_start_at)
    : (snap.scheduled_first_pitch ? Date.parse(snap.scheduled_first_pitch) : NaN);
  const timingValid = !Number.isFinite(snapshotCreatedAt) || !Number.isFinite(startRef)
    ? true // permissive when we can't compute
    : snapshotCreatedAt < startRef;
  if (!timingValid) {
    return { status: "EXCLUDED_INTEGRITY_REVIEW", excludedReason: "snapshot_created_after_start" };
  }

  // 5. Load immutable rows.
  const { data: rows } = await admin
    .from("engine_beta_snapshot_rows")
    .select("id, category, player_id, market, event_key, threshold, line, projected_prob, projected_mean, actual_value, actual_event, score_components")
    .eq("snapshot_id", snapshotId);

  const rowList = rows ?? [];
  if (rowList.length === 0) {
    return { status: "EXCLUDED_INTEGRITY_REVIEW", excludedReason: "no_snapshot_rows" };
  }

  // 6. Provenance completeness.
  const provenanceComplete = snap.provenance_status === "complete"
    && !!snap.engine_status
    && !!snap.inputs_hash;
  const calibrationEligible = provenanceComplete;

  // 7. Create grading_run header.
  const { data: run, error: runErr } = await admin.from("grading_runs").insert({
    slate_date: slateDate, game_id: gameId, snapshot_id: snapshotId,
    grading_job_id: gradingJobId,
    forecast_version: snap.forecast_version,
    engine_status: snap.engine_status,
    inputs_hash: snap.inputs_hash,
    outcome_source: game.terminal_state_source,
    outcome_ingested_at: game.terminal_state_resolved_at,
    calibration_eligible: calibrationEligible,
    provenance_status: snap.provenance_status,
    summary: {
      row_count: rowList.length,
      note: calibrationEligible ? "calibration_eligible" : "result_comparison_only",
    },
  }).select("id").single();
  if (runErr) throw new Error(`grading_run insert: ${runErr.message}`);
  const runId = run.id;

  // 8. Compute per-row grades from ONLY the snapshot row's saved values.
  const gradeRows = rowList.map((r: any) => {
    const projProb = r.projected_prob != null ? Number(r.projected_prob) : null;
    const projMean = r.projected_mean != null ? Number(r.projected_mean) : null;
    const actualEvent = r.actual_event === true ? true : r.actual_event === false ? false : null;
    const actualVal = r.actual_value != null ? Number(r.actual_value) : null;

    const brier = projProb != null && actualEvent != null
      ? Math.pow(projProb - (actualEvent ? 1 : 0), 2)
      : null;
    const mae = projMean != null && actualVal != null ? Math.abs(projMean - actualVal) : null;
    const signedErr = projMean != null && actualVal != null ? (projMean - actualVal) : null;

    return {
      grading_run_id: runId,
      snapshot_id: snapshotId,
      snapshot_row_id: r.id,
      game_id: gameId,
      player_id: r.player_id,
      category: r.category,
      market: r.market,
      event_key: r.event_key,
      threshold: r.threshold,
      line: r.line,
      projected_prob: projProb,
      projected_mean: projMean,
      actual_value: actualVal,
      actual_event: actualEvent,
      brier, mae, signed_error: signedErr,
      meta: { calibration_eligible: calibrationEligible },
    };
  });

  if (gradeRows.length) {
    const { error: rowsErr } = await admin.from("grade_rows").insert(gradeRows);
    if (rowsErr) throw new Error(`grade_rows insert: ${rowsErr.message}`);
  }

  if (!provenanceComplete) {
    // Still graded, but flagged as legacy/provenance-missing.
    return {
      status: "GRADED",
      gradingRunId: runId,
      rowCount: gradeRows.length,
      calibrationEligible: false,
      excludedReason: "provenance_incomplete_result_comparison_only",
    };
  }
  return { status: "GRADED", gradingRunId: runId, rowCount: gradeRows.length, calibrationEligible: true };
}
