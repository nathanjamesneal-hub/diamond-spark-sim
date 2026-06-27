/**
 * Thin helper around `public.automation_log` used by the slate orchestrator
 * and live actuals worker. Server-only — uses the service-role client.
 *
 * Never throw from a logger; logging failures must not break the pipeline.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type AutomationStatus = "started" | "ok" | "skipped" | "partial" | "failed";

export type AutomationLogInput = {
  job: string;
  status: AutomationStatus;
  slate_date?: string | null;
  game_pk?: number | null;
  decision?: string | null;
  details?: Record<string, unknown>;
  error?: string | null;
  started_at?: string;
  finished_at?: string | null;
  duration_ms?: number | null;
};

export async function logAutomation(
  supabaseAdmin: SupabaseClient,
  input: AutomationLogInput,
): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("automation_log")
      .insert({
        job: input.job,
        status: input.status,
        slate_date: input.slate_date ?? null,
        game_pk: input.game_pk ?? null,
        decision: input.decision ?? null,
        details: input.details ?? {},
        error: input.error ?? null,
        started_at: input.started_at ?? new Date().toISOString(),
        finished_at: input.finished_at ?? null,
        duration_ms: input.duration_ms ?? null,
      })
      .select("id")
      .single();
    if (error) {
      // eslint-disable-next-line no-console
      console.warn("[automation_log] insert failed", error.message);
      return null;
    }
    return (data as any)?.id ?? null;
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn("[automation_log] insert threw", e?.message ?? e);
    return null;
  }
}

export async function finishAutomationLog(
  supabaseAdmin: SupabaseClient,
  id: string | null,
  patch: {
    status: AutomationStatus;
    details?: Record<string, unknown>;
    error?: string | null;
    finished_at?: string;
    duration_ms?: number;
  },
): Promise<void> {
  if (!id) return;
  try {
    const finished_at = patch.finished_at ?? new Date().toISOString();
    await supabaseAdmin
      .from("automation_log")
      .update({
        status: patch.status,
        details: patch.details ?? {},
        error: patch.error ?? null,
        finished_at,
        duration_ms: patch.duration_ms ?? null,
      })
      .eq("id", id);
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn("[automation_log] update threw", e?.message ?? e);
  }
}
