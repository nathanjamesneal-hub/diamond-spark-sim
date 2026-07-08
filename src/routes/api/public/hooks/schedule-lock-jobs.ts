/**
 * Schedules durable per-game lock_jobs rows for today's slate (Chicago) and
 * yesterday's (for late games that crossed midnight CT). Idempotent via the
 * UNIQUE(slate_date, game_id) constraint on lock_jobs.
 *
 * Auth: requires the Supabase anon key in `apikey` header.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/schedule-lock-jobs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response(
            JSON.stringify({ ok: false, error: "unauthorized" }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { scheduleLockJobsForSlate } = await import("@/lib/lock-jobs/scheduler.server");
        const { todayInAppTz } = await import("@/lib/timezone");

        const today = todayInAppTz();
        const y = new Date(`${today}T00:00:00`);
        y.setDate(y.getDate() - 1);
        const ydate = y.toISOString().slice(0, 10);

        const [t, yr] = await Promise.all([
          scheduleLockJobsForSlate(supabaseAdmin as any, today),
          scheduleLockJobsForSlate(supabaseAdmin as any, ydate),
        ]);
        return Response.json({ ok: true, results: [t, yr], at: new Date().toISOString() });
      },
    },
  },
});
