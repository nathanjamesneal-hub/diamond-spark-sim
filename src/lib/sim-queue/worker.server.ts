/**
 * Diamond Official Simulation — durable worker.
 *
 * Runs one tick of the queue: claims sim_jobs, executes chunks of real Monte
 * Carlo iterations via the `diamond-adapter.server` adapter (which wraps the
 * full-game engine in `src/lib/sim/engine.ts`), persists per-chunk deltas so
 * subsequent ticks resume without replay, then finalizes into
 * `sim_player_outputs`.
 *
 * Engine tag: `diamond_mc_candidate`. NOT `validated` — Prop Board treats
 * these rows as Preview until documented calibration evidence lands.
 *
 * Legacy scaffold rows created by the old `simulateChunkPlaceholder` remain
 * in the table for historical audit; new jobs never call the placeholder.
 * Server-only. Loaded lazily inside server-function handlers.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  DIAMOND_ADAPTER_VERSION,
  DIAMOND_ENGINE_STATUS,
  loadDiamondRoster,
  mergeDelta,
  percentilesFromHist,
  simulateDiamondChunk,
  type AggState,
  type ChunkDelta,
  type DiamondRoster,
} from "@/lib/sim/diamond-adapter.server";

const LEASE_MS = 90_000;              // 90s per pickup; refreshed after each chunk
const STALE_LEASE_MS = 120_000;       // leases older than this may be reclaimed
const CHUNK_TIMEOUT_MS = 60_000;      // per-chunk wall-clock guard
const MAX_CHUNKS_PER_TICK = 4;        // bounded work per invocation so a tick stays short


export type WorkerTickResult = {
  ok: boolean;
  workerId: string;
  picked: number;
  chunksExecuted: number;
  jobsCompleted: number;
  jobsFailed: number;
  events: Array<{
    jobId: string;
    kind: "picked" | "chunk_ok" | "chunk_err" | "completed" | "failed" | "stale" | "skipped";
    detail?: string;
    chunkIndex?: number;
    attempt?: number;
  }>;
  error?: string;
};

type SimJobRow = {
  id: string;
  game_id: string;
  game_pk: number;
  slate_date: string;
  model_version: string;
  inputs_hash: string;
  tier: "2k" | "20k";
  label: "preview" | "early_slate" | "confirmed";
  sim_count: number;
  chunk_size: number;
  chunks_total: number;
  chunks_done: number;
  seed: string | null;
  seed_meta: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  chunk_progress: Record<string, { done?: boolean; at?: string; delta?: ChunkDelta }>;
  engine_status: "scaffold_unvalidated" | "diamond_mc_candidate" | "validated";
  worker_lease_id: string | null;
  worker_lease_expires_at: string | null;
  started_at: string | null;
  projection_stage: "early" | "updated" | "lineup_confirmed" | "final_pregame" | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Worker core.
// ─────────────────────────────────────────────────────────────────────────────



async function claimJob(admin: SupabaseClient, workerId: string): Promise<SimJobRow | null> {
  const leaseExpires = new Date(Date.now() + LEASE_MS).toISOString();
  const staleBefore = new Date(Date.now() - STALE_LEASE_MS).toISOString();

  // Two-pass claim without a stored proc: pick candidate, then compare-and-swap on lease.
  const { data: candidates } = await admin
    .from("sim_jobs")
    .select("id, worker_lease_id, worker_lease_expires_at, status, attempts, max_attempts")
    .in("status", ["queued", "running"])
    .or(`worker_lease_id.is.null,worker_lease_expires_at.lt.${staleBefore}`)
    // Newest-first so we always pick the current inputs_hash for each
    // (game, tier); older enqueues for the same key would be superseded by
    // verifyInputsFresh and marked stale, wasting worker ticks.
    .order("queued_at", { ascending: false })
    .limit(25);

  for (const c of candidates ?? []) {
    if ((c.attempts ?? 0) >= (c.max_attempts ?? 3)) continue;
    const newLeaseId = randomUUID();
    // CAS: match the exact lease we observed (null or specific stale id).
    let query = admin
      .from("sim_jobs")
      .update({
        worker_lease_id: newLeaseId,
        worker_lease_expires_at: leaseExpires,
        status: "running",
        started_at: c.status === "queued" ? new Date().toISOString() : undefined,
        attempts: (c.attempts ?? 0) + 1,
        last_progress_at: new Date().toISOString(),
      })
      .eq("id", c.id);
    if (c.worker_lease_id === null) {
      query = query.is("worker_lease_id", null);
    } else {
      query = query.eq("worker_lease_id", c.worker_lease_id);
    }
    const { data: swapped } = await query.select("*").maybeSingle();
    if (swapped) return swapped as SimJobRow;

  }
  return null;
}

async function refreshLease(admin: SupabaseClient, job: SimJobRow): Promise<void> {
  await admin
    .from("sim_jobs")
    .update({
      worker_lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
      last_progress_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .eq("worker_lease_id", job.worker_lease_id!);
}

async function verifyInputsFresh(admin: SupabaseClient, job: SimJobRow): Promise<{ current: boolean; currentHash: string | null }> {
  // Re-derive: compare the job's inputs_hash to the most recent enqueue hash for this game+tier.
  // A newer job with a different hash means our inputs are stale.
  const { data: latest } = await admin
    .from("sim_jobs")
    .select("inputs_hash, queued_at")
    .eq("game_id", job.game_id)
    .eq("tier", job.tier)
    .order("queued_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return { current: true, currentHash: job.inputs_hash };
  return { current: latest.inputs_hash === job.inputs_hash, currentHash: latest.inputs_hash };
}

async function writeOutputs(
  admin: SupabaseClient,
  job: SimJobRow,
  state: AggState,
): Promise<number> {
  const rows: Array<Record<string, unknown>> = [];
  const stageOut = job.projection_stage ?? "legacy_unknown";
  const projectionStageValid = ["early", "updated", "lineup_confirmed", "final_pregame"].includes(stageOut) ? stageOut : null;
  for (const [key, s] of state) {
    const playerId = key.split("|")[0];
    const mean = s.n > 0 ? s.sum / s.n : 0;
    const eventProb = s.n > 0 ? s.hits / s.n : 0;
    // MC standard error of proportion.
    const stderr = s.n > 0 ? Math.sqrt(Math.max(0, eventProb * (1 - eventProb) / s.n)) : 0;
    // Confidence: shrink toward 0 when the sample is tiny; 20K full run ~= 1.0.
    const confidence = Math.min(1, Math.max(0, 1 - stderr * 6));
    const pcts = percentilesFromHist(s.hist);
    const side = s.threshold == null ? null : "over"; // adapter emits Over-side probabilities

    rows.push({
      sim_job_id: job.id,
      game_id: job.game_id,
      game_pk: job.game_pk,
      slate_date: job.slate_date,
      model_version: `${job.model_version}+${DIAMOND_ADAPTER_VERSION}`,
      inputs_hash: job.inputs_hash,
      sim_tier: job.tier,
      sim_count: s.n,
      run_status: "current",
      engine_status: DIAMOND_ENGINE_STATUS,
      projection_stage: projectionStageValid,
      player_id: playerId,
      player_type: s.playerType,
      team_id: s.teamId,
      opponent_team_id: s.oppTeamId,
      batting_order: s.battingOrder,
      projected_pa: s.playerType === "bat" ? 4.3 : null,
      projected_bf: s.playerType === "pit" ? 22.0 : null,
      handedness: s.handedness,
      opp_handedness: null,
      market: s.market,
      threshold: s.threshold,
      projected_mean: mean,
      event_probability: eventProb,
      baseline_mean: mean,
      baseline_event_probability: eventProb,
      form_adjustment: 0,
      form_prob_adjustment: 0,
      percentile_summary: { ...pcts, side },
      stderr,
      confidence,
      form_sample_size: null,
      form_reliability: null,
      form_direction: "neutral",
      driver_metadata: {
        engine: DIAMOND_ADAPTER_VERSION,
        engine_status: DIAMOND_ENGINE_STATUS,
        source: "diamond-mc-candidate",
        note: "Real Monte Carlo per-PA simulation via engine.ts. Preview tier until calibrated.",
        pitcher_rates: "league-average with deterministic per-pitcher jitter",
        batter_rates: "derived from player_dna (contact/power/speed/discipline)",
        correlation: "per-game baserunner state links H/HR/RBI/R/TB; iterations independent; no cross-game correlation",
        stage_source: job.projection_stage ? "sim_jobs.projection_stage" : "legacy_unknown",
      },
      completed_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) return 0;
  // Idempotent by unique (sim_job_id, player_id, market).
  const { error } = await admin
    .from("sim_player_outputs")
    .upsert(rows, { onConflict: "sim_job_id,player_id,market" });
  if (error) throw new Error(`sim_player_outputs upsert: ${error.message}`);

  // Flip prior current rows for this (game, tier) with a different inputs_hash to 'stale'.
  await admin
    .from("sim_player_outputs")
    .update({ run_status: "stale" })
    .eq("game_id", job.game_id)
    .eq("sim_tier", job.tier)
    .eq("run_status", "current")
    .neq("inputs_hash", job.inputs_hash);

  return rows.length;
}


async function markChunkStart(admin: SupabaseClient, job: SimJobRow, chunkIndex: number, attempt: number): Promise<string> {
  const id = randomUUID();
  await admin.from("sim_job_chunk_runs").insert({
    id,
    sim_job_id: job.id,
    chunk_index: chunkIndex,
    attempt,
    status: "running",
    worker_lease_id: job.worker_lease_id,
    sim_count: job.chunk_size,
    started_at: new Date().toISOString(),
  });
  return id;
}

async function markChunkResult(
  admin: SupabaseClient,
  chunkRunId: string,
  status: "completed" | "failed" | "timed_out",
  startedAt: number,
  error?: string,
): Promise<void> {
  await admin
    .from("sim_job_chunk_runs")
    .update({
      status,
      error: error ?? null,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
    })
    .eq("id", chunkRunId);
}

async function persistProgress(
  admin: SupabaseClient,
  job: SimJobRow,
  chunksDone: number,
  progress: Record<string, unknown>,
): Promise<void> {
  await admin
    .from("sim_jobs")
    .update({
      chunks_done: chunksDone,
      chunk_progress: progress,
      last_progress_at: new Date().toISOString(),
      worker_lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
    })
    .eq("id", job.id)
    .eq("worker_lease_id", job.worker_lease_id!);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

/** Advance a single claimed job by up to `MAX_CHUNKS_PER_TICK` chunks. */
async function runJob(
  admin: SupabaseClient,
  job: SimJobRow,
  events: WorkerTickResult["events"],
): Promise<"completed" | "in_progress" | "failed" | "stale"> {
  // Check freshness once at pickup; if stale, mark and stop.
  const freshness = await verifyInputsFresh(admin, job);
  if (!freshness.current) {
    await admin
      .from("sim_jobs")
      .update({ status: "stale", failure_reason: `superseded by newer inputs_hash=${freshness.currentHash}`, worker_lease_id: null, worker_lease_expires_at: null })
      .eq("id", job.id);
    events.push({ jobId: job.id, kind: "stale", detail: `superseded by ${freshness.currentHash}` });
    return "stale";
  }

  // Load real Diamond roster (lineups + starters + player_dna).
  let roster: DiamondRoster;
  try {
    roster = await loadDiamondRoster(admin, job);
  } catch (e: any) {
    events.push({ jobId: job.id, kind: "chunk_err", detail: `roster: ${e?.message ?? String(e)}` });
    throw e;
  }
  // Rehydrate aggregator from persisted per-chunk deltas — no replay needed.
  const state: AggState = new Map();
  const alreadyDone: Set<number> = new Set();
  for (const [k, v] of Object.entries(job.chunk_progress ?? {})) {
    const n = Number(k);
    if (!Number.isFinite(n)) continue;
    if (v?.done) alreadyDone.add(n);
    if (v?.delta) mergeDelta(state, v.delta);
  }

  let chunksDone = job.chunks_done;
  let executed = 0;

  for (let idx = 0; idx < job.chunks_total; idx++) {
    if (alreadyDone.has(idx)) continue;
    if (executed >= MAX_CHUNKS_PER_TICK) break;

    const attempt = 1;
    const chunkRunId = await markChunkStart(admin, job, idx, attempt);
    const startedAt = Date.now();
    try {
      let delta: ChunkDelta = [];
      await withTimeout(
        Promise.resolve().then(() => { delta = simulateDiamondChunk(job, idx, roster, state); }),
        CHUNK_TIMEOUT_MS,
        `chunk ${idx}`,
      );
      await markChunkResult(admin, chunkRunId, "completed", startedAt);
      chunksDone++;
      alreadyDone.add(idx);
      const progress = { ...(job.chunk_progress ?? {}), [String(idx)]: { done: true, at: new Date().toISOString(), delta } };
      await persistProgress(admin, job, chunksDone, progress);
      await refreshLease(admin, job);
      events.push({ jobId: job.id, kind: "chunk_ok", chunkIndex: idx, attempt });

      executed++;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const timedOut = msg.startsWith("timeout");
      await markChunkResult(admin, chunkRunId, timedOut ? "timed_out" : "failed", startedAt, msg);
      events.push({ jobId: job.id, kind: "chunk_err", chunkIndex: idx, attempt, detail: msg });
      // Bubble up: the whole tick call will fail this job attempt; if attempts < max, it will be re-picked.
      if ((job.attempts ?? 0) >= (job.max_attempts ?? 3)) {
        await admin.from("sim_jobs").update({
          status: "failed",
          failure_reason: `chunk ${idx} ${timedOut ? "timed out" : "failed"}: ${msg}`,
          last_error: msg,
          worker_lease_id: null,
          worker_lease_expires_at: null,
        }).eq("id", job.id);
        events.push({ jobId: job.id, kind: "failed", detail: msg });
        return "failed";
      } else {
        await admin.from("sim_jobs").update({
          status: "queued", // requeue for next tick
          last_error: msg,
          worker_lease_id: null,
          worker_lease_expires_at: null,
        }).eq("id", job.id);
        return "in_progress";
      }
    }
  }

  if (chunksDone >= job.chunks_total) {
    // Finalize: idempotent upsert of the current-state outputs + flip stale peers.
    let finalizerStatus = "ok";
    try {
      const written = await writeOutputs(admin, job, state);
      if (written === 0) {
        // Guardrail: a job MUST NOT complete with zero output rows. Common
        // cause: empty lineups/starters at execution time. Mark as failed so
        // it retries once the roster is populated (or hits max_attempts).
        throw new Error("finalizer: zero output rows (empty roster or aggregator)");
      }
      await admin.from("sim_jobs").update({
        status: "completed",
        chunks_done: chunksDone,
        completed_at: new Date().toISOString(),
        duration_ms: job.started_at ? Date.now() - new Date(job.started_at).getTime() : null,
        worker_lease_id: null,
        worker_lease_expires_at: null,
        finalizer_status: `wrote ${written} rows`,
        // engine_status stays whatever the executed simulator set. NEVER promote here.
      }).eq("id", job.id);
      events.push({ jobId: job.id, kind: "completed", detail: `rows=${written}` });
    } catch (e: any) {
      finalizerStatus = `err:${e?.message ?? String(e)}`;
      const permanent = (job.attempts ?? 0) >= (job.max_attempts ?? 3);
      await admin.from("sim_jobs").update({
        // Retry the finalizer up to max_attempts; permanent failure only after that.
        status: permanent ? "failed" : "queued",
        // Reset chunks_done so the retry re-aggregates and re-runs the finalizer.
        chunks_done: permanent ? chunksDone : 0,
        chunk_progress: permanent ? job.chunk_progress : {},
        last_error: e?.message ?? String(e),
        finalizer_status: finalizerStatus,
        failure_reason: permanent ? `finalizer: ${e?.message ?? String(e)}` : null,
        worker_lease_id: null,
        worker_lease_expires_at: null,
      }).eq("id", job.id);
      events.push({ jobId: job.id, kind: permanent ? "failed" : "chunk_err", detail: finalizerStatus });
      return permanent ? "failed" : "in_progress";
    }
    return "completed";
  }

  return "in_progress";
}

export async function runWorkerTick(admin: SupabaseClient, maxJobs = 3): Promise<WorkerTickResult> {
  const workerId = randomUUID();
  const events: WorkerTickResult["events"] = [];
  let picked = 0;
  let chunksExecuted = 0;
  let jobsCompleted = 0;
  let jobsFailed = 0;

  try {
    for (let i = 0; i < maxJobs; i++) {
      const job = await claimJob(admin, workerId);
      if (!job) break;
      picked++;
      events.push({ jobId: job.id, kind: "picked" });
      const before = events.length;
      const outcome = await runJob(admin, job, events);
      chunksExecuted += events.slice(before).filter((e) => e.kind === "chunk_ok").length;
      if (outcome === "completed") jobsCompleted++;
      if (outcome === "failed") jobsFailed++;
    }
    return { ok: true, workerId, picked, chunksExecuted, jobsCompleted, jobsFailed, events };
  } catch (e: any) {
    return { ok: false, workerId, picked, chunksExecuted, jobsCompleted, jobsFailed, events, error: e?.message ?? String(e) };
  }
}
