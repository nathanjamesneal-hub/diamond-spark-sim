/**
 * Diamond Official Simulation — Phase 3a durable worker (SCAFFOLD).
 *
 * ⚠️  Every run this worker produces is marked `engine_status = 'scaffold_unvalidated'`
 *     on both `sim_jobs` and `sim_player_outputs`. The `simulateChunk` implementation
 *     below is a deterministic PLACEHOLDER used only to validate queue plumbing:
 *     lease pickup, chunk resumability, progress persistence, idempotent writes,
 *     current/stale flips, retry, timeout, and finalizer logging.
 *
 *     Scaffold rows MUST be filtered out of every downstream consumer
 *     (Form Movers, Projection Leaders, Prop Leaders, Diamond Consensus,
 *     auto-lock, and final grading). They are labeled "Pipeline Test /
 *     Uncalibrated" in every UI surface. Do not use them for projections,
 *     rankings, or historical model claims.
 *
 *     Only Phase 3b's real Monte Carlo engine may set `engine_status = 'validated'`.
 *     When it lands, replace ONLY `simulateChunk` — the queue contract,
 *     outputs schema, audit trail, and immutability rules must stay unchanged.
 *
 * Server-only. Loaded lazily inside server-function handlers.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

const LEASE_MS = 90_000;              // 90s per pickup; refreshed after each chunk
const STALE_LEASE_MS = 120_000;       // leases older than this may be reclaimed
const CHUNK_TIMEOUT_MS = 60_000;      // per-chunk wall-clock guard (scaffold work is trivial)
const MAX_CHUNKS_PER_TICK = 4;        // bounded work per invocation so a tick stays short
const SCAFFOLD_ENGINE_VERSION = "scaffold-uncalibrated-0.1";

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
  chunk_progress: Record<string, unknown>;
  engine_status: "scaffold_unvalidated" | "validated";
  worker_lease_id: string | null;
  worker_lease_expires_at: string | null;
  started_at: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER simulator.
//
// Produces coherent-shaped, deterministic rows so the plumbing test can prove
// idempotency, chunk resumability, and current/stale flips against real data.
// It is NOT calibrated, NOT correlated across players, and NOT a projection.
// ─────────────────────────────────────────────────────────────────────────────

type PlaceholderPlayer = {
  player_id: string;
  player_type: "bat" | "pit";
  team_id: string | null;
  opponent_team_id: string | null;
  batting_order: number | null;
  handedness: string | null;
};

type PlaceholderMarket = { market: string; threshold: number | null };

const HITTER_MARKETS: PlaceholderMarket[] = [
  { market: "1plus_hit", threshold: null },
  { market: "2plus_hits", threshold: null },
  { market: "total_bases", threshold: 1.5 },
  { market: "hr", threshold: null },
];
const PITCHER_MARKETS: PlaceholderMarket[] = [
  { market: "k", threshold: 5.5 },
  { market: "outs", threshold: 15.5 },
  { market: "er", threshold: 2.5 },
];

function seededRand(seed: string, key: string): number {
  const h = createHash("sha256").update(`${seed}::${key}`).digest();
  // Take 4 bytes → 0..1
  const n = h.readUInt32BE(0) / 0xffffffff;
  return n;
}

async function loadRoster(admin: SupabaseClient, job: SimJobRow): Promise<PlaceholderPlayer[]> {
  const { data: lineups } = await admin
    .from("lineups")
    .select("game_id, team_id, player_id, batting_order")
    .eq("game_id", job.game_id);
  const { data: starters } = await admin
    .from("starting_pitchers")
    .select("game_id, team_id, player_id")
    .eq("game_id", job.game_id);

  const players: PlaceholderPlayer[] = [];
  // We need home/away split so opponent_team is meaningful.
  const { data: gameRow } = await admin
    .from("games")
    .select("home_team_id, away_team_id")
    .eq("id", job.game_id)
    .maybeSingle();
  const home = gameRow?.home_team_id ?? null;
  const away = gameRow?.away_team_id ?? null;
  const opp = (teamId: string | null) => (teamId === home ? away : teamId === away ? home : null);

  for (const l of lineups ?? []) {
    players.push({
      player_id: l.player_id,
      player_type: "bat",
      team_id: l.team_id,
      opponent_team_id: opp(l.team_id),
      batting_order: l.batting_order ?? null,
      handedness: null,
    });
  }
  for (const s of starters ?? []) {
    players.push({
      player_id: s.player_id,
      player_type: "pit",
      team_id: s.team_id,
      opponent_team_id: opp(s.team_id),
      batting_order: null,
      handedness: null,
    });
  }
  return players;
}

/**
 * PLACEHOLDER. Do not treat outputs as projections.
 *
 * Contract preserved for the real engine:
 *   in:  (job, chunkIndex, players, aggregatorState)
 *   out: updated aggregatorState that, when finalized, becomes the per-player rows.
 */
function simulateChunkPlaceholder(
  job: SimJobRow,
  chunkIndex: number,
  players: PlaceholderPlayer[],
  state: Map<string, { market: string; threshold: number | null; hits: number; sum: number; n: number; playerType: "bat" | "pit"; teamId: string | null; oppTeamId: string | null; battingOrder: number | null; handedness: string | null }>,
): void {
  const chunkN = job.chunk_size;
  const seed = job.seed ?? job.id;

  for (const p of players) {
    const markets = p.player_type === "bat" ? HITTER_MARKETS : PITCHER_MARKETS;
    for (const m of markets) {
      const key = `${p.player_id}|${m.market}`;
      let s = state.get(key);
      if (!s) {
        s = {
          market: m.market,
          threshold: m.threshold,
          hits: 0,
          sum: 0,
          n: 0,
          playerType: p.player_type,
          teamId: p.team_id,
          oppTeamId: p.opponent_team_id,
          battingOrder: p.batting_order,
          handedness: p.handedness,
        };
        state.set(key, s);
      }
      // Coherent-shaped deterministic draws — NOT calibrated.
      // Mean is a stable function of (player, market); each chunk adds `chunkN`
      // "observations" drawn around that mean using seeded jitter.
      const meanBase =
        m.market === "1plus_hit" ? 0.62 :
        m.market === "2plus_hits" ? 0.24 :
        m.market === "total_bases" ? 1.35 :
        m.market === "hr" ? 0.13 :
        m.market === "k" ? 6.2 :
        m.market === "outs" ? 16.5 :
        m.market === "er" ? 2.7 : 0.5;

      const jitter = (seededRand(seed, `${key}|${chunkIndex}|mean`) - 0.5) * 0.2;
      const meanThisChunk = Math.max(0, meanBase * (1 + jitter));

      // Approximate: assume every "sim" contributes one value ≈ meanThisChunk with a
      // small deterministic spread. hits count uses the same value vs threshold.
      const spread = seededRand(seed, `${key}|${chunkIndex}|spread`) * 0.3;
      const perDraw = meanThisChunk;
      const hitProb = m.threshold == null
        ? Math.min(1, Math.max(0, meanThisChunk))
        : Math.min(1, Math.max(0, meanThisChunk > m.threshold ? 0.5 + spread : 0.5 - spread));

      s.sum += perDraw * chunkN;
      s.hits += Math.round(hitProb * chunkN);
      s.n += chunkN;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker core (real).
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
    .order("queued_at", { ascending: true })
    .limit(5);

  for (const c of candidates ?? []) {
    if ((c.attempts ?? 0) >= (c.max_attempts ?? 3)) continue;
    const newLeaseId = randomUUID();
    const { data: swapped } = await admin
      .from("sim_jobs")
      .update({
        worker_lease_id: newLeaseId,
        worker_lease_expires_at: leaseExpires,
        status: "running",
        started_at: c.status === "queued" ? new Date().toISOString() : undefined,
        attempts: (c.attempts ?? 0) + 1,
        last_progress_at: new Date().toISOString(),
      })
      .eq("id", c.id)
      // CAS: only claim if the lease we saw is still what's there.
      .is("worker_lease_id", c.worker_lease_id === null ? null : undefined)
      .select("*")
      .maybeSingle();
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
  state: Map<string, any>,
): Promise<number> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [key, s] of state) {
    const playerId = key.split("|")[0];
    const mean = s.n > 0 ? s.sum / s.n : 0;
    const eventProb = s.n > 0 ? s.hits / s.n : 0;
    // MC standard error of proportion.
    const stderr = s.n > 0 ? Math.sqrt(Math.max(0, eventProb * (1 - eventProb) / s.n)) : 0;
    // Confidence: shrink toward 0 when the sample is tiny; 20K full run ~= 1.0.
    const confidence = Math.min(1, Math.max(0, 1 - stderr * 6));

    rows.push({
      sim_job_id: job.id,
      game_id: job.game_id,
      game_pk: job.game_pk,
      slate_date: job.slate_date,
      model_version: `${job.model_version}+${SCAFFOLD_ENGINE_VERSION}`,
      inputs_hash: job.inputs_hash,
      sim_tier: job.tier,
      sim_count: s.n,
      run_status: "current",
      engine_status: "scaffold_unvalidated",
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
      baseline_mean: mean,                 // scaffold has no separate baseline
      baseline_event_probability: eventProb,
      form_adjustment: 0,
      form_prob_adjustment: 0,
      percentile_summary: null,
      stderr,
      confidence,
      form_sample_size: null,
      form_reliability: null,
      form_direction: "neutral",
      driver_metadata: {
        note: "SCAFFOLD placeholder — not a projection",
        engine: SCAFFOLD_ENGINE_VERSION,
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

  // Rebuild aggregator from any completed chunks by re-running them (deterministic seed makes
  // this cheap for the scaffold; the real engine will persist chunk aggregates instead).
  const players = await loadRoster(admin, job);
  const state = new Map<string, any>();
  const alreadyDone: Set<number> = new Set(
    Object.keys(job.chunk_progress ?? {}).map((k) => Number(k)).filter((n) => Number.isFinite(n)),
  );
  for (const idx of alreadyDone) simulateChunkPlaceholder(job, idx, players, state);

  let chunksDone = job.chunks_done;
  let executed = 0;

  for (let idx = 0; idx < job.chunks_total; idx++) {
    if (alreadyDone.has(idx)) continue;
    if (executed >= MAX_CHUNKS_PER_TICK) break;

    const attempt = 1; // scaffold: chunks are re-tried at the job level, not per-chunk
    const chunkRunId = await markChunkStart(admin, job, idx, attempt);
    const startedAt = Date.now();
    try {
      await withTimeout(
        Promise.resolve().then(() => simulateChunkPlaceholder(job, idx, players, state)),
        CHUNK_TIMEOUT_MS,
        `chunk ${idx}`,
      );
      await markChunkResult(admin, chunkRunId, "completed", startedAt);
      chunksDone++;
      alreadyDone.add(idx);
      const progress = { ...(job.chunk_progress ?? {}), [String(idx)]: { done: true, at: new Date().toISOString() } };
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
      await admin.from("sim_jobs").update({
        status: "completed",
        chunks_done: chunksDone,
        completed_at: new Date().toISOString(),
        duration_ms: job.started_at ? Date.now() - new Date(job.started_at).getTime() : null,
        worker_lease_id: null,
        worker_lease_expires_at: null,
        finalizer_status: `wrote ${written} rows`,
        // engine_status stays 'scaffold_unvalidated'. NEVER promote in the scaffold worker.
      }).eq("id", job.id);
      events.push({ jobId: job.id, kind: "completed", detail: `rows=${written}` });
    } catch (e: any) {
      finalizerStatus = `err:${e?.message ?? String(e)}`;
      await admin.from("sim_jobs").update({
        status: "failed",
        last_error: e?.message ?? String(e),
        finalizer_status: finalizerStatus,
        failure_reason: `finalizer: ${e?.message ?? String(e)}`,
        worker_lease_id: null,
        worker_lease_expires_at: null,
      }).eq("id", job.id);
      events.push({ jobId: job.id, kind: "failed", detail: finalizerStatus });
      return "failed";
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
