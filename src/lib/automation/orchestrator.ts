/**
 * Diamond slate orchestrator.
 *
 * Per-stage instrumented, timeout-bounded, lease-guarded.
 *
 * Guarantees (see `stage.ts` for the primitives):
 *   1. The parent `automation_log` row is ALWAYS closed. A `finally` block
 *      writes a terminal status even if a stage throws, times out, or the
 *      orchestrator itself is aborted mid-body (the row is closed on the
 *      *next* cycle by the lease-recovery path).
 *   2. Every stage writes its own child log row with status, duration,
 *      records considered/updated, and actionable error text.
 *   3. A DB-backed lease prevents overlapping cycles from stacking on top of
 *      a stuck run. A stale lease is recovered and the recovery is logged.
 *   4. Every stage is capped by an explicit `budgetMs`. Exceeded stages are
 *      recorded as `timed_out` and the run moves on. (JS cannot cancel the
 *      underlying promise, but the row is closed immediately so cron cycles
 *      never block on it.)
 *
 * Server-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { todayInAppTz } from "@/lib/timezone";
import { runRefresh } from "@/lib/lineups/refresh.functions";
import { lockForecastsForLiveGames } from "@/lib/forecast/lifecycle";
import { runPetriAutoForDate } from "@/lib/petri/run.functions";
import { ensureScheduleForDate } from "@/lib/schedule.server";
import { autoLockPregameForDate } from "@/lib/engine-beta/autolock";
import { enqueueSimJobsForDate } from "@/lib/sim-queue/enqueue.server";

import { finishAutomationLog, logAutomation } from "./log";
import {
  acquireLease, releaseLease, withStage,
  type StageOutcome,
} from "./stage";

// ---------- Budgets (per-stage wall time caps) ----------
// Conservative. Tuned so total worst case < Cloudflare Worker request limit.
const BUDGETS = {
  schedule: 20_000,
  refresh: 120_000,
  lock: 15_000,
  petri: 120_000,
  autolock: 60_000,
  enqueueSims: 15_000,
} as const;
const LEASE_TTL_MS = 5 * 60_000;

// ---------- Fault injection (test-only) ----------

export type FaultInjection = Partial<Record<
  "schedule" | "refresh" | "lock" | "petri" | "autolock",
  "throw" | "timeout"
>>;

function applyFault<T>(
  stage: keyof FaultInjection,
  fault: FaultInjection | undefined,
  real: () => Promise<T>,
): () => Promise<T> {
  const mode = fault?.[stage];
  if (!mode) return real;
  if (mode === "throw") return () => Promise.reject(new Error(`injected fault: ${stage} threw`));
  // 'timeout' — sleep past any conceivable stage budget.
  return () => new Promise<T>((resolve) => setTimeout(() => resolve({} as T), 10 * 60_000));
}

// ---------- Result shape (backwards-compatible with existing callers) ----------

export type OrchestrateResult = {
  ok: boolean;
  date: string;
  yesterdayDate: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  lease: { acquired: boolean; recovered: boolean; recoveredExpiredAt: string | null; blockedReason?: string };
  stages: Array<{
    stage: string; status: string; durationMs: number; error: string | null;
    recordsConsidered: number | null; recordsUpdated: number | null; timedOut: boolean;
  }>;
  schedule: { gamesFetched: number; gamesUpserted: number; inserted: number; updated: number; teamsUpserted: number; error?: string };
  refresh: { changedGameIds: number; publicationGapGameIds: number; projectionsRegenerated: number; engineRan: boolean; error?: string };
  recentEvents: { finalGames: number; gameEventRows: number; rollupRows: number; pitcherHitTypesSourced: boolean; error?: string };
  lock: { today: number; yesterday: number; error?: string };
  petri: { previewGenerated: number; officialGenerated: number; abstained: number; skipped: number; locked: number; error?: string };
  engineBetaAutoLock: { processed: number; locked: number; missed: number; skipped: number; error?: string };
  error?: string;
};

function chicagoYesterday(today: string): string {
  const d = new Date(`${today}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function emptyResult(date: string, startedAt: Date): OrchestrateResult {
  return {
    ok: true, date, yesterdayDate: chicagoYesterday(date),
    startedAt: startedAt.toISOString(), finishedAt: startedAt.toISOString(), durationMs: 0,
    lease: { acquired: false, recovered: false, recoveredExpiredAt: null },
    stages: [],
    schedule: { gamesFetched: 0, gamesUpserted: 0, inserted: 0, updated: 0, teamsUpserted: 0 },
    refresh: { changedGameIds: 0, publicationGapGameIds: 0, projectionsRegenerated: 0, engineRan: false },
    recentEvents: { finalGames: 0, gameEventRows: 0, rollupRows: 0, pitcherHitTypesSourced: false },
    lock: { today: 0, yesterday: 0 },
    petri: { previewGenerated: 0, officialGenerated: 0, abstained: 0, skipped: 0, locked: 0 },
    engineBetaAutoLock: { processed: 0, locked: 0, missed: 0, skipped: 0 },
  };
}

function pushStage<T>(result: OrchestrateResult, o: StageOutcome<T>) {
  result.stages.push({
    stage: o.stage, status: o.status, durationMs: o.durationMs, error: o.error,
    recordsConsidered: o.recordsConsidered, recordsUpdated: o.recordsUpdated, timedOut: o.timedOut,
  });
}

export async function orchestrateDiamondSlate(
  supabaseAdmin: SupabaseClient,
  opts?: { date?: string; fault?: FaultInjection; holder?: string },
): Promise<OrchestrateResult> {
  const startedAt = new Date();
  const date = opts?.date ?? todayInAppTz();
  const yesterdayDate = chicagoYesterday(date);
  const result = emptyResult(date, startedAt);

  // ---- Concurrency lease ----
  const lease = await acquireLease(supabaseAdmin, {
    job: "orchestrate-slate", slateDate: date, ttlMs: LEASE_TTL_MS, holder: opts?.holder ?? "cron",
  });
  if (!lease.acquired) {
    result.lease.blockedReason = `active lease held until ${lease.expiresAt}`;
    const finishedAt = new Date();
    result.finishedAt = finishedAt.toISOString();
    result.durationMs = finishedAt.getTime() - startedAt.getTime();
    // Write a single 'blocked' row (no children) so the block is visible.
    await logAutomation(supabaseAdmin, {
      job: "orchestrate-slate", status: "blocked", slate_date: date,
      started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(),
      duration_ms: result.durationMs,
      details: { reason: "active_lease", expiresAt: lease.expiresAt, holder: lease.holder },
      error: null,
    });
    return result;
  }
  result.lease.acquired = true;
  result.lease.recovered = lease.recovered;
  result.lease.recoveredExpiredAt = lease.recoveredExpiredAt;

  // ---- Parent log row ----
  const logId = await logAutomation(supabaseAdmin, {
    job: "orchestrate-slate", status: "started", slate_date: date,
    started_at: startedAt.toISOString(),
    details: { yesterdayDate, leaseRecovered: lease.recovered, leaseId: lease.leaseId },
  });

  // Update the parent's last_progress_at as stages complete (best-effort).
  const bumpHeartbeat = async () => {
    if (!logId) return;
    try { await (supabaseAdmin as any).from("automation_log").update({ last_progress_at: new Date().toISOString() }).eq("id", logId); } catch { /* ignore */ }
  };

  try {
    // 1) Schedule refresh ------------------------------------------------
    {
      const o = await withStage(supabaseAdmin, { parentId: logId, stage: "schedule", slateDate: date, budgetMs: BUDGETS.schedule },
        async () => {
          const s = await applyFault("schedule", opts?.fault, () => ensureScheduleForDate(supabaseAdmin, date))();
          const anyS = s as any;
          const gamesFetched = anyS?.gamesFetched ?? 0;
          const gamesUpserted = anyS?.gamesUpserted ?? 0;
          const status = anyS?.error || (gamesFetched > 0 && gamesUpserted === 0) ? "failed" as const : "ok" as const;
          return {
            data: anyS,
            status,
            recordsConsidered: gamesFetched,
            recordsUpdated: gamesUpserted,
            details: anyS ? {
              gamesFetched, gamesUpserted, inserted: anyS?.inserted ?? 0,
              updated: anyS?.updated ?? 0, teamsUpserted: anyS?.teamsUpserted ?? 0,
              error: anyS?.error ?? null,
            } : {},
          };
        });
      pushStage(result, o);
      const s = o.data as any;
      if (s) {
        result.schedule.gamesFetched = s.gamesFetched ?? 0;
        result.schedule.gamesUpserted = s.gamesUpserted ?? 0;
        result.schedule.inserted = s.inserted ?? 0;
        result.schedule.updated = s.updated ?? 0;
        result.schedule.teamsUpserted = s.teamsUpserted ?? 0;
        if (s.error) result.schedule.error = s.error;
      }
      if (o.status !== "ok") { result.schedule.error = o.error ?? result.schedule.error; result.ok = false; }
      await bumpHeartbeat();
    }

    // 2) Lineup + starter + engine + recent events (single primitive) --
    {
      const o = await withStage(supabaseAdmin, { parentId: logId, stage: "refresh", slateDate: date, budgetMs: BUDGETS.refresh },
        async () => {
          const r = await applyFault("refresh", opts?.fault, () => runRefresh(date))();
          const anyR = r as any;
          const changed = anyR?.changedGameIds?.length ?? 0;
          const gaps = anyR?.publicationGapGameIds?.length ?? 0;
          const projs = anyR?.projectionsRegenerated ?? 0;
          return {
            data: anyR,
            status: anyR?.ok === false ? "failed" as const : "ok" as const,
            recordsConsidered: changed + gaps,
            recordsUpdated: projs,
            details: {
              changedGameIds: changed, publicationGapGameIds: gaps,
              projectionsRegenerated: projs, engineRan: !!anyR?.engineRan,
              recentEvents: anyR?.recentEvents ?? null,
              error: anyR?.error ?? null,
            },
          };
        });
      pushStage(result, o);
      const r = o.data as any;
      if (r) {
        result.refresh.changedGameIds = r.changedGameIds?.length ?? 0;
        result.refresh.publicationGapGameIds = r.publicationGapGameIds?.length ?? 0;
        result.refresh.projectionsRegenerated = r.projectionsRegenerated ?? 0;
        result.refresh.engineRan = !!r.engineRan;
        if (r.recentEvents) {
          result.recentEvents.finalGames = r.recentEvents.finalGames ?? 0;
          result.recentEvents.gameEventRows = r.recentEvents.gameEventRows ?? 0;
          result.recentEvents.rollupRows = r.recentEvents.rollupRows ?? 0;
          result.recentEvents.pitcherHitTypesSourced = !!r.recentEvents.pitcherHitTypesSourced;
          if (r.recentEvents.error) result.recentEvents.error = r.recentEvents.error;
        }
        if (r.ok === false && r.error) result.refresh.error = r.error;
      }
      if (o.status !== "ok") { result.refresh.error = o.error ?? result.refresh.error; result.ok = false; }
      await bumpHeartbeat();
    }

    // 3) First-pitch hard lock (today + yesterday) ---------------------
    {
      const o = await withStage(supabaseAdmin, { parentId: logId, stage: "lock", slateDate: date, budgetMs: BUDGETS.lock },
        async () => {
          const [today, yesterday] = await applyFault("lock", opts?.fault, async () => Promise.all([
            lockForecastsForLiveGames(supabaseAdmin, date),
            lockForecastsForLiveGames(supabaseAdmin, yesterdayDate),
          ]))();
          const locked = (Number(today) || 0) + (Number(yesterday) || 0);
          return {
            data: { today, yesterday },
            recordsUpdated: locked,
            details: { today, yesterday },
          };
        });
      pushStage(result, o);
      const d = o.data as any;
      if (d) { result.lock.today = d.today ?? 0; result.lock.yesterday = d.yesterday ?? 0; }
      if (o.status !== "ok") { result.lock.error = o.error ?? undefined; result.ok = false; }
      await bumpHeartbeat();
    }

    // 4) Petri v0.2 shadow (isolated from Alpha) -----------------------
    {
      const o = await withStage(supabaseAdmin, { parentId: logId, stage: "petri", slateDate: date, budgetMs: BUDGETS.petri },
        async () => {
          const p = await applyFault("petri", opts?.fault, () => runPetriAutoForDate(supabaseAdmin, date))();
          const anyP = p as any;
          const generated = (anyP?.preview?.generated ?? 0) + (anyP?.official?.generated ?? 0);
          return {
            data: anyP,
            recordsConsidered: (anyP?.abstained?.length ?? 0) + (anyP?.skipped?.length ?? 0) + generated,
            recordsUpdated: generated + (anyP?.locked ?? 0),
            details: {
              previewGenerated: anyP?.preview?.generated ?? 0,
              officialGenerated: anyP?.official?.generated ?? 0,
              locked: anyP?.locked ?? 0,
              abstained: anyP?.abstained?.length ?? 0,
              skipped: anyP?.skipped?.length ?? 0,
            },
          };
        });
      pushStage(result, o);
      const p = o.data as any;
      if (p) {
        result.petri.previewGenerated = p.preview?.generated ?? 0;
        result.petri.officialGenerated = p.official?.generated ?? 0;
        result.petri.abstained = p.abstained?.length ?? 0;
        result.petri.skipped = p.skipped?.length ?? 0;
        result.petri.locked = p.locked ?? 0;
      }
      // Petri failures don't fail the whole run (existing policy) but they DO show in stage row.
      if (o.status !== "ok") result.petri.error = o.error ?? undefined;
      await bumpHeartbeat();
    }

    // 5) Engine Beta per-game auto-lock --------------------------------
    {
      const o = await withStage(supabaseAdmin, { parentId: logId, stage: "autolock", slateDate: date, budgetMs: BUDGETS.autolock },
        async () => {
          const a = await applyFault("autolock", opts?.fault, () => autoLockPregameForDate(supabaseAdmin, date))();
          const anyA = a as any;
          return {
            data: anyA,
            recordsConsidered: anyA?.processed ?? 0,
            recordsUpdated: (anyA?.locked ?? 0) + (anyA?.missed ?? 0),
            details: {
              processed: anyA?.processed ?? 0, locked: anyA?.locked ?? 0,
              missed: anyA?.missed ?? 0, skipped: anyA?.skipped ?? 0,
              error: anyA?.error ?? null,
            },
          };
        });
      pushStage(result, o);
      const a = o.data as any;
      if (a) {
        result.engineBetaAutoLock.processed = a.processed ?? 0;
        result.engineBetaAutoLock.locked = a.locked ?? 0;
        result.engineBetaAutoLock.missed = a.missed ?? 0;
        result.engineBetaAutoLock.skipped = a.skipped ?? 0;
        if (a.error) result.engineBetaAutoLock.error = a.error;
      }
      if (o.status !== "ok") result.engineBetaAutoLock.error = o.error ?? result.engineBetaAutoLock.error;
      await bumpHeartbeat();
    }
  } finally {
    // ALWAYS close the parent row and release the lease, no matter what
    // happened above. This is the guarantee the July 5 pipeline was missing.
    const finishedAt = new Date();
    result.finishedAt = finishedAt.toISOString();
    result.durationMs = finishedAt.getTime() - startedAt.getTime();

    const anyStageFailed = result.stages.some(s => s.status === "failed" || s.status === "timed_out");
    const anyStageOk = result.stages.some(s => s.status === "ok" && (s.recordsUpdated ?? 0) > 0);
    let status: "ok" | "skipped" | "partial" | "failed";
    if (anyStageFailed && anyStageOk) status = "partial";
    else if (anyStageFailed) status = "failed";
    else if (anyStageOk) status = "ok";
    else status = "skipped";

    await finishAutomationLog(supabaseAdmin, logId, {
      status,
      finished_at: result.finishedAt,
      duration_ms: result.durationMs,
      details: {
        stages: result.stages,
        schedule: result.schedule, refresh: result.refresh, recentEvents: result.recentEvents,
        lock: result.lock, petri: result.petri, engineBetaAutoLock: result.engineBetaAutoLock,
        lease: result.lease,
      },
      error: result.stages.find(s => s.error)?.error ?? null,
    });

    await releaseLease(supabaseAdmin, {
      job: "orchestrate-slate", slateDate: date, leaseId: lease.leaseId,
    });
  }

  return result;
}
