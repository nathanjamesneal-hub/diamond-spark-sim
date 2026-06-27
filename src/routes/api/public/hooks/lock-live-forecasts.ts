/**
 * Cron-driven first-pitch lock.
 *
 * Called every minute by pg_cron. Atomically flips any active official
 * forecast run from `published` to `locked` once its game has started.
 * Preserves every other column on `forecast_runs` and never touches
 * `forecast_player_projections`. Idempotent.
 *
 * Auth: requires the Supabase anon key in the `apikey` header to prevent
 * arbitrary internet callers from triggering the job. `/api/public/*`
 * bypasses our auth gate, so we verify the header here.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/lock-live-forecasts")({
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

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const { lockForecastsForLiveGames } = await import(
          "@/lib/forecast/lifecycle"
        );
        const { todayInAppTz } = await import("@/lib/timezone");

        // Today's Chicago slate plus yesterday — handle games that crossed
        // midnight CT into the next calendar day.
        const today = todayInAppTz();
        const yesterday = new Date(`${today}T00:00:00`);
        yesterday.setDate(yesterday.getDate() - 1);
        const ydate = yesterday.toISOString().slice(0, 10);

        const [todayLocked, yesterdayLocked] = await Promise.all([
          lockForecastsForLiveGames(supabaseAdmin, today),
          lockForecastsForLiveGames(supabaseAdmin, ydate),
        ]);

        return Response.json({
          ok: true,
          locked: todayLocked + yesterdayLocked,
          by_date: { [today]: todayLocked, [ydate]: yesterdayLocked },
          at: new Date().toISOString(),
        });
      },
    },
  },
});
