/**
 * Admin-only telemetry server fn for the automation pipeline.
 * Returns the most recent log rows for each job so the Lineup Status
 * board can show "last run / status / age" tiles.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAppMember } from "@/integrations/supabase/member-middleware";

export type AutomationRow = {
  id: string;
  job: string;
  status: string;
  slate_date: string | null;
  game_pk: number | null;
  decision: string | null;
  details: unknown;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
};

export type AutomationTelemetry = {
  fetchedAt: string;
  byJob: Record<string, AutomationRow | null>;
  recent: AutomationRow[];
};

const TRACKED_JOBS = ["orchestrate-slate", "refresh-live-actuals"] as const;

export const getAutomationTelemetry = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .handler(async (): Promise<AutomationTelemetry> => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    const byJob: Record<string, AutomationRow | null> = {};
    await Promise.all(
      TRACKED_JOBS.map(async (job) => {
        const { data } = await supabaseAdmin
          .from("automation_log")
          .select("*")
          .eq("job", job)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        byJob[job] = (data as AutomationRow | null) ?? null;
      }),
    );

    const { data: recent } = await supabaseAdmin
      .from("automation_log")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(25);

    return {
      fetchedAt: new Date().toISOString(),
      byJob,
      recent: (recent ?? []) as AutomationRow[],
    };
  });
