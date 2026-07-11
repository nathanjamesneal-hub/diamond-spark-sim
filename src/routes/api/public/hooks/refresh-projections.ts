/**
 * Runs one tick of the projection refresh planner for today's slate (and
 * yesterday's, so late games that crossed midnight CT are still tracked).
 *
 * Called by pg_cron on a mixed cadence (every 15m all day, every 5m in the
 * T-3h window, plus a T-10m final check).
 *
 * Auth: requires the Supabase publishable key in the `apikey` header.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/refresh-projections")({
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
        const { runProjectionRefreshPlanner } = await import(
          "@/lib/projection-refresh/planner.server"
        );
        const { todayInAppTz } = await import("@/lib/timezone");

        const today = todayInAppTz();
        const y = new Date(`${today}T00:00:00`);
        y.setDate(y.getDate() - 1);
        const ydate = y.toISOString().slice(0, 10);

        const [t, yr] = await Promise.all([
          runProjectionRefreshPlanner(supabaseAdmin as any, today),
          runProjectionRefreshPlanner(supabaseAdmin as any, ydate),
        ]);
        return Response.json({ ok: true, results: [t, yr], at: new Date().toISOString() });
      },
    },
  },
});
