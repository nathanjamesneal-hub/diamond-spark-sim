/**
 * Per-stage instrumentation for long-running orchestrations.
 *
 * Guarantees:
 * - Every stage writes a `started` row and a terminal row (`ok`, `skipped`,
 *   `failed`, or `timed_out`) — even on throw or timeout.
 * - The parent row's `last_progress_at` is bumped after every stage so hangs
 *   are visible even when the parent finalizer never runs.
 * - `withStage` NEVER throws to its caller; failures are captured in the row
 *   and returned as `{ status, error }`. This lets an orchestrator body wrap
 *   every stage independently without try/catch clutter.
 *
 * Server-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type StageStatus = "ok" | "skipped" | "failed" | "timed_out" | "blocked";

export type StageOutcome<T> = {
  stage: string;
  status: StageStatus;
  durationMs: number;
  error: string | null;
  data: T | null;
  recordsConsidered: number | null;
  recordsUpdated: number | null;
  timedOut: boolean;
};

export type StageFnResult<T> = {
  data: T;
  status?: StageStatus; // default 'ok'
  recordsConsidered?: number;
  recordsUpdated?: number;
  details?: Record<string, unknown>;
};

export class StageTimeoutError extends Error {
  constructor(public readonly budgetMs: number, public readonly stage: string) {
    super(`stage '${stage}' exceeded ${budgetMs}ms budget`);
    this.name = "StageTimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new StageTimeoutError(ms, stage)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function safeInsertStageStart(
  admin: SupabaseClient,
  args: { parentId: string | null; stage: string; slateDate: string | null; startedAt: string },
): Promise<string | null> {
  try {
    const { data, error } = await (admin as any)
      .from("automation_log")
      .insert({
        job: "orchestrate-slate.stage",
        stage: args.stage,
        parent_id: args.parentId,
        slate_date: args.slateDate,
        status: "started",
        started_at: args.startedAt,
        last_progress_at: args.startedAt,
      })
      .select("id")
      .single();
    if (error) return null;
    return (data as any)?.id ?? null;
  } catch { return null; }
}

async function safeCloseStageRow(
  admin: SupabaseClient,
  id: string | null,
  patch: {
    status: StageStatus;
    finishedAt: string;
    durationMs: number;
    error: string | null;
    details: Record<string, unknown>;
    recordsConsidered: number | null;
    recordsUpdated: number | null;
  },
): Promise<void> {
  if (!id) return;
  try {
    await (admin as any).from("automation_log").update({
      status: patch.status,
      finished_at: patch.finishedAt,
      duration_ms: patch.durationMs,
      last_progress_at: patch.finishedAt,
      error: patch.error,
      details: patch.details,
      records_considered: patch.recordsConsidered,
      records_updated: patch.recordsUpdated,
    }).eq("id", id);
  } catch { /* logging failures must never break the pipeline */ }
}

async function safeHeartbeat(
  admin: SupabaseClient,
  parentId: string | null,
  now: string,
): Promise<void> {
  if (!parentId) return;
  try {
    await (admin as any).from("automation_log")
      .update({ last_progress_at: now }).eq("id", parentId);
  } catch { /* ignore */ }
}

/**
 * Run one instrumented stage. Never throws. Always writes a terminal row.
 * If `budgetMs` is exceeded the underlying operation continues in the
 * background (JS cannot cancel it) but the row is closed as `timed_out`
 * immediately so cron cycles are never stuck waiting on it.
 */
export async function withStage<T>(
  admin: SupabaseClient,
  args: {
    parentId: string | null;
    stage: string;
    slateDate: string | null;
    budgetMs: number;
  },
  fn: () => Promise<StageFnResult<T>>,
): Promise<StageOutcome<T>> {
  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  const rowId = await safeInsertStageStart(admin, {
    parentId: args.parentId,
    stage: args.stage,
    slateDate: args.slateDate,
    startedAt: startedIso,
  });

  let outcome: StageOutcome<T>;
  try {
    const res = await withTimeout(fn(), args.budgetMs, args.stage);
    const finishedAt = new Date();
    const status: StageStatus = res.status ?? "ok";
    outcome = {
      stage: args.stage, status,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: null, data: res.data, timedOut: false,
      recordsConsidered: res.recordsConsidered ?? null,
      recordsUpdated: res.recordsUpdated ?? null,
    };
    await safeCloseStageRow(admin, rowId, {
      status, finishedAt: finishedAt.toISOString(),
      durationMs: outcome.durationMs, error: null,
      details: res.details ?? {},
      recordsConsidered: outcome.recordsConsidered,
      recordsUpdated: outcome.recordsUpdated,
    });
  } catch (e: any) {
    const finishedAt = new Date();
    const timedOut = e instanceof StageTimeoutError;
    const status: StageStatus = timedOut ? "timed_out" : "failed";
    const message = e?.message ?? String(e);
    outcome = {
      stage: args.stage, status,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: message, data: null, timedOut,
      recordsConsidered: null, recordsUpdated: null,
    };
    await safeCloseStageRow(admin, rowId, {
      status, finishedAt: finishedAt.toISOString(),
      durationMs: outcome.durationMs, error: message,
      details: { budgetMs: args.budgetMs, timedOut },
      recordsConsidered: null, recordsUpdated: null,
    });
  }

  await safeHeartbeat(admin, args.parentId, new Date().toISOString());
  return outcome;
}

// ---------- Concurrency lease ----------

export type LeaseAcquireResult =
  | { acquired: true; leaseId: string; recovered: boolean; recoveredExpiredAt: string | null }
  | { acquired: false; reason: "active_lease"; expiresAt: string; holder: string | null };

/**
 * Acquire an exclusive lease for (job, slate_date). If a prior lease is still
 * active (expires_at > now, released_at IS NULL), acquisition fails. If it is
 * expired, we take it over and report `recovered: true`.
 */
export async function acquireLease(
  admin: SupabaseClient,
  args: { job: string; slateDate: string; ttlMs: number; holder?: string },
): Promise<LeaseAcquireResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.ttlMs).toISOString();

  // Read existing.
  const { data: existing } = await (admin as any)
    .from("automation_leases")
    .select("lease_id, holder, acquired_at, expires_at, released_at")
    .eq("job", args.job)
    .eq("slate_date", args.slateDate)
    .maybeSingle();

  const nowIso = now.toISOString();
  if (existing && !existing.released_at && existing.expires_at > nowIso) {
    return {
      acquired: false, reason: "active_lease",
      expiresAt: existing.expires_at, holder: existing.holder ?? null,
    };
  }

  // Insert or overwrite.
  const recovered = !!(existing && !existing.released_at && existing.expires_at <= nowIso);
  const recoveredExpiredAt = recovered ? existing!.expires_at : null;

  const { data, error } = await (admin as any)
    .from("automation_leases")
    .upsert({
      job: args.job,
      slate_date: args.slateDate,
      holder: args.holder ?? null,
      acquired_at: nowIso,
      expires_at: expiresAt,
      released_at: null,
      lease_id: crypto.randomUUID(),
    }, { onConflict: "job,slate_date" })
    .select("lease_id")
    .single();

  if (error) {
    return { acquired: false, reason: "active_lease", expiresAt, holder: null };
  }
  return { acquired: true, leaseId: (data as any).lease_id, recovered, recoveredExpiredAt };
}

export async function releaseLease(
  admin: SupabaseClient,
  args: { job: string; slateDate: string; leaseId: string },
): Promise<void> {
  try {
    await (admin as any)
      .from("automation_leases")
      .update({ released_at: new Date().toISOString() })
      .eq("job", args.job)
      .eq("slate_date", args.slateDate)
      .eq("lease_id", args.leaseId);
  } catch { /* ignore */ }
}
