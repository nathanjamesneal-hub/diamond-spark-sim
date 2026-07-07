/**
 * Durable per-game lock-job worker.
 *
 * Contract:
 *  - Claims due jobs (lock_at <= now, status PENDING/RETRY, lease expired).
 *  - Retries only while now < hard_stop_at.
 *  - At now >= hard_stop_at: writes MISSED_PREGAME with precise reason,
 *    never creates a historical pregame snapshot.
 *  - Idempotent: unique constraint on (slate_date, game_id) + snapshot
 *    idempotency in the underlying autolock path.
 *  - Logs / flags lateness > 30s.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { tryAutoLockGame } from "@/lib/engine-beta/autolock";
import { classifyGameState, pregameSnapshotAllowed } from "./game-state";

const LEASE_MS = 60_000;
const LATE_THRESHOLD_MS = 30_000;

export type LockWorkerResult = {
  now: string;
  claimed: number;
  locked: number;
  missed: number;
  postponed: number;
  errors: number;
  late: number;
  outcomes: Array<{
    lockJobId: string;
    gameId: string;
    outcome: string;
    reason: string | null;
    latenessSeconds: number;
    gameStateClass: string;
  }>;
};

export async function runLockWorker(
  admin: SupabaseClient<any>,
  opts?: { workerId?: string; maxJobs?: number },
): Promise<LockWorkerResult> {
  const workerId = opts?.workerId ?? `worker-${Math.random().toString(36).slice(2, 8)}`;
  const maxJobs = opts?.maxJobs ?? 25;
  const nowIso = new Date().toISOString();
  const now = new Date(nowIso);
  const result: LockWorkerResult = {
    now: nowIso, claimed: 0, locked: 0, missed: 0, postponed: 0, errors: 0, late: 0, outcomes: [],
  };

  // 1. Find due jobs whose lock_at has arrived AND lease is free/expired.
  const { data: due, error: dueErr } = await admin
    .from("lock_jobs")
    .select("id, slate_date, game_id, game_pk, scheduled_first_pitch, lock_at, hard_stop_at, status, attempt_count, lease_until")
    .in("status", ["PENDING", "RETRY"])
    .lte("lock_at", nowIso)
    .order("lock_at", { ascending: true })
    .limit(maxJobs);
  if (dueErr) throw new Error(`lock_jobs load: ${dueErr.message}`);

  for (const job of due ?? []) {
    const leaseExpired = !job.lease_until || Date.parse(job.lease_until) <= now.getTime();
    if (!leaseExpired) continue;

    // 2. Claim with optimistic lock: only update if lease is still free.
    const newLease = new Date(now.getTime() + LEASE_MS).toISOString();
    const { data: claimed, error: claimErr } = await admin
      .from("lock_jobs")
      .update({
        status: "RUNNING",
        claimed_at: nowIso,
        claimed_by: workerId,
        lease_until: newLease,
        started_at: nowIso,
        attempt_count: (job.attempt_count ?? 0) + 1,
      })
      .eq("id", job.id)
      .in("status", ["PENDING", "RETRY"])
      .select("id")
      .maybeSingle();
    if (claimErr || !claimed) continue; // raced
    result.claimed += 1;

    const latenessMs = Math.max(0, now.getTime() - Date.parse(job.lock_at));
    const latenessSeconds = Math.round(latenessMs / 1000);
    if (latenessMs > LATE_THRESHOLD_MS) {
      result.late += 1;
      // eslint-disable-next-line no-console
      console.warn("[lock-worker.late]", JSON.stringify({
        lockJobId: job.id, gameId: job.game_id, latenessSeconds, workerId,
      }));
    }

    // 3. Hard-stop guard: if now >= hard_stop_at, mark MISSED_PREGAME.
    if (now.getTime() >= Date.parse(job.hard_stop_at)) {
      await admin.from("lock_jobs").update({
        status: "MISSED_PREGAME",
        completed_at: nowIso,
        lateness_seconds: latenessSeconds,
        outcome: "MISSED_PREGAME",
        outcome_reason: "hard_stop_reached",
        lease_until: null,
      }).eq("id", job.id);
      result.missed += 1;
      result.outcomes.push({
        lockJobId: job.id, gameId: job.game_id, outcome: "MISSED_PREGAME",
        reason: "hard_stop_reached", latenessSeconds, gameStateClass: "NOT_STARTED",
      });
      continue;
    }

    // 4. Read current game state and classify.
    const { data: game } = await admin
      .from("games")
      .select("id, mlb_game_id, first_pitch_at, game_status, date, actual_start_at")
      .eq("id", job.game_id)
      .maybeSingle();
    if (!game) {
      await admin.from("lock_jobs").update({
        status: "GRADE_FAILED", completed_at: nowIso, lateness_seconds: latenessSeconds,
        last_error: "game_not_found", lease_until: null,
      }).eq("id", job.id);
      result.errors += 1;
      continue;
    }

    const stateClass = classifyGameState({
      game_status: game.game_status,
      actual_start_at: game.actual_start_at ?? null,
      scheduled_first_pitch: game.first_pitch_at,
    }, now.getTime());

    // 5. Postponed / suspended → record separately, do not create pregame snapshot.
    if (stateClass === "POSTPONED_OR_SUSPENDED") {
      await admin.from("lock_jobs").update({
        status: "POSTPONED_OR_SUSPENDED", completed_at: nowIso, lateness_seconds: latenessSeconds,
        outcome: "POSTPONED_OR_SUSPENDED", outcome_reason: game.game_status, lease_until: null,
      }).eq("id", job.id);
      result.postponed += 1;
      result.outcomes.push({
        lockJobId: job.id, gameId: job.game_id, outcome: "POSTPONED_OR_SUSPENDED",
        reason: game.game_status, latenessSeconds, gameStateClass: stateClass,
      });
      continue;
    }

    // 6. Actually started → never create a new pregame snapshot.
    if (stateClass === "ACTUALLY_STARTED" || !pregameSnapshotAllowed(
      { game_status: game.game_status, actual_start_at: game.actual_start_at ?? null }, now.getTime(),
    )) {
      await admin.from("lock_jobs").update({
        status: "MISSED_PREGAME", completed_at: nowIso, lateness_seconds: latenessSeconds,
        outcome: "MISSED_PREGAME", outcome_reason: `game_started:${game.game_status ?? "unknown"}`,
        lease_until: null,
      }).eq("id", job.id);
      result.missed += 1;
      result.outcomes.push({
        lockJobId: job.id, gameId: job.game_id, outcome: "MISSED_PREGAME",
        reason: `game_started:${game.game_status ?? "unknown"}`,
        latenessSeconds, gameStateClass: stateClass,
      });
      continue;
    }

    // 7. Attempt the actual lock via the existing autolock path.
    try {
      const outcome = await tryAutoLockGame(admin, game, now, 2, 30);
      const snapshotId = outcome.status !== "skipped" ? outcome.snapshotId : null;

      // 7a. Backfill provenance + game_state_class on the fresh snapshot.
      if (snapshotId) {
        await admin.from("engine_beta_snapshots").update({
          game_state_class: stateClass,
          provenance_status: "complete",
          calibration_eligible: outcome.status === "locked",
          actual_start_at: game.actual_start_at ?? null,
        }).eq("id", snapshotId);

        // 7b. Enqueue grading job for locked snapshots.
        if (outcome.status === "locked") {
          await admin.from("grading_jobs").insert({
            slate_date: job.slate_date, game_id: job.game_id,
            snapshot_id: snapshotId, status: "PENDING_FINAL",
          }).select("id").maybeSingle();
        }
      }

      const finalStatus =
        outcome.status === "locked" ? "LOCKED"
        : outcome.status === "missed" ? "MISSED_PREGAME"
        : "SKIPPED";

      await admin.from("lock_jobs").update({
        status: finalStatus,
        completed_at: nowIso,
        lateness_seconds: latenessSeconds,
        snapshot_id: snapshotId,
        outcome: outcome.status.toUpperCase(),
        outcome_reason: outcome.reason,
        lease_until: null,
      }).eq("id", job.id);

      if (outcome.status === "locked") result.locked += 1;
      else if (outcome.status === "missed") result.missed += 1;

      result.outcomes.push({
        lockJobId: job.id, gameId: job.game_id, outcome: outcome.status,
        reason: outcome.reason ?? null, latenessSeconds, gameStateClass: stateClass,
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const nowAfter = Date.now();
      const hardStopMs = Date.parse(job.hard_stop_at);
      const canRetry = nowAfter < hardStopMs;
      await admin.from("lock_jobs").update({
        status: canRetry ? "RETRY" : "GRADE_FAILED",
        last_error: msg,
        lease_until: null,
        completed_at: canRetry ? null : nowIso,
        lateness_seconds: latenessSeconds,
      }).eq("id", job.id);
      result.errors += 1;
    }
  }

  return result;
}

/** Reclaim stale leases whose lease_until has passed while status = RUNNING. */
export async function reclaimStaleLockLeases(admin: SupabaseClient<any>): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data } = await admin
    .from("lock_jobs")
    .update({ status: "RETRY", lease_until: null, claimed_at: null, claimed_by: null })
    .eq("status", "RUNNING")
    .lt("lease_until", nowIso)
    .select("id");
  return data?.length ?? 0;
}
