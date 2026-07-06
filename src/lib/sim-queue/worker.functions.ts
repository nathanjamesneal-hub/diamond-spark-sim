/**
 * Sim-queue server functions — admin-only.
 *
 * Endpoints:
 *   - runSimWorkerTick: manually advance the queue (used by the smoke test).
 *   - getSimQueueDiagnostics: per-job progress, chunks, lease, freshness, and
 *     the counts that prove partial/scaffold runs are correctly gated out
 *     of every official consumer.
 *
 * SCAFFOLD guardrail: every row produced by this worker carries
 * engine_status = 'scaffold_unvalidated'. Diagnostics surface this so the
 * UI can never mislabel it as Official 20K.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

export const runSimWorkerTick = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { maxJobs?: number } | undefined) => data ?? {})
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runWorkerTick } = await import("@/lib/sim-queue/worker.server");
    return runWorkerTick(supabaseAdmin as any, Math.min(5, Math.max(1, data.maxJobs ?? 3)));
  });

export type SimQueueDiagnostics = {
  jobs: Array<{
    id: string;
    game_id: string;
    game_pk: number;
    slate_date: string;
    tier: "2k" | "20k";
    label: string;
    status: string;
    engine_status: "scaffold_unvalidated" | "validated";
    chunks_done: number;
    chunks_total: number;
    attempts: number;
    max_attempts: number;
    inputs_hash: string;
    worker_lease_id: string | null;
    worker_lease_expires_at: string | null;
    started_at: string | null;
    completed_at: string | null;
    last_progress_at: string | null;
    last_error: string | null;
    finalizer_status: string | null;
    failure_reason: string | null;
    chunk_runs: Array<{
      chunk_index: number;
      attempt: number;
      status: string;
      duration_ms: number | null;
      started_at: string;
      completed_at: string | null;
      error: string | null;
    }>;
    outputs: {
      row_count: number;
      distinct_players: number;
      distinct_markets: number;
      current_row_count: number;
      stale_row_count: number;
      scaffold_row_count: number;
      validated_row_count: number;
      duplicate_rows: number; // must be 0 (unique index enforces)
    };
  }>;
  guardrails: {
    total_rows: number;
    scaffold_rows: number;
    validated_rows: number;
    partial_jobs_blocked_from_leaderboards: number; // count of running/queued jobs whose rows must be excluded
  };
};

export const getSimQueueDiagnostics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { slateDate?: string; limit?: number } | undefined) => data ?? {})
  .handler(async ({ data, context }): Promise<SimQueueDiagnostics> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let jobsQuery = supabaseAdmin
      .from("sim_jobs")
      .select("*")
      .order("queued_at", { ascending: false })
      .limit(Math.min(50, Math.max(1, data.limit ?? 20)));
    if (data.slateDate) jobsQuery = jobsQuery.eq("slate_date", data.slateDate);

    const { data: jobs, error: jErr } = await jobsQuery;
    if (jErr) throw new Error(jErr.message);
    const jobIds = (jobs ?? []).map((j: any) => j.id);
    if (jobIds.length === 0) {
      return {
        jobs: [],
        guardrails: {
          total_rows: 0,
          scaffold_rows: 0,
          validated_rows: 0,
          partial_jobs_blocked_from_leaderboards: 0,
        },
      };
    }

    const [{ data: chunkRuns }, { data: outputs }] = await Promise.all([
      supabaseAdmin
        .from("sim_job_chunk_runs")
        .select("sim_job_id, chunk_index, attempt, status, duration_ms, started_at, completed_at, error")
        .in("sim_job_id", jobIds)
        .order("chunk_index", { ascending: true })
        .order("attempt", { ascending: true }),
      supabaseAdmin
        .from("sim_player_outputs")
        .select("sim_job_id, player_id, market, run_status, engine_status")
        .in("sim_job_id", jobIds),
    ]);

    const chunkByJob = new Map<string, any[]>();
    for (const c of chunkRuns ?? []) {
      const arr = chunkByJob.get(c.sim_job_id) ?? [];
      arr.push(c);
      chunkByJob.set(c.sim_job_id, arr);
    }

    const outByJob = new Map<string, any[]>();
    for (const o of outputs ?? []) {
      const arr = outByJob.get(o.sim_job_id) ?? [];
      arr.push(o);
      outByJob.set(o.sim_job_id, arr);
    }

    const jobRows = (jobs ?? []).map((j: any) => {
      const os = outByJob.get(j.id) ?? [];
      const players = new Set(os.map((r: any) => r.player_id));
      const markets = new Set(os.map((r: any) => r.market));
      const keySet = new Set<string>();
      let duplicates = 0;
      for (const r of os) {
        const k = `${r.player_id}|${r.market}`;
        if (keySet.has(k)) duplicates++;
        keySet.add(k);
      }
      return {
        id: j.id,
        game_id: j.game_id,
        game_pk: j.game_pk,
        slate_date: j.slate_date,
        tier: j.tier,
        label: j.label,
        status: j.status,
        engine_status: j.engine_status,
        chunks_done: j.chunks_done,
        chunks_total: j.chunks_total,
        attempts: j.attempts,
        max_attempts: j.max_attempts,
        inputs_hash: j.inputs_hash,
        worker_lease_id: j.worker_lease_id,
        worker_lease_expires_at: j.worker_lease_expires_at,
        started_at: j.started_at,
        completed_at: j.completed_at,
        last_progress_at: j.last_progress_at,
        last_error: j.last_error,
        finalizer_status: j.finalizer_status,
        failure_reason: j.failure_reason,
        chunk_runs: chunkByJob.get(j.id) ?? [],
        outputs: {
          row_count: os.length,
          distinct_players: players.size,
          distinct_markets: markets.size,
          current_row_count: os.filter((r: any) => r.run_status === "current").length,
          stale_row_count: os.filter((r: any) => r.run_status === "stale").length,
          scaffold_row_count: os.filter((r: any) => r.engine_status === "scaffold_unvalidated").length,
          validated_row_count: os.filter((r: any) => r.engine_status === "validated").length,
          duplicate_rows: duplicates,
        },
      };
    });

    const total = jobRows.reduce((n, j) => n + j.outputs.row_count, 0);
    const scaffold = jobRows.reduce((n, j) => n + j.outputs.scaffold_row_count, 0);
    const validated = jobRows.reduce((n, j) => n + j.outputs.validated_row_count, 0);
    const partial = jobRows.filter((j) => j.status === "running" || j.status === "queued").length;

    return {
      jobs: jobRows,
      guardrails: {
        total_rows: total,
        scaffold_rows: scaffold,
        validated_rows: validated,
        partial_jobs_blocked_from_leaderboards: partial,
      },
    };
  });
