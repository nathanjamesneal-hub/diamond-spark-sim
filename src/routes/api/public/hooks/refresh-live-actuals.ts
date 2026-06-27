/**
 * pg_cron-driven live actuals worker endpoint.
 *
 * Called every minute. Keeps `public.games.game_status` in sync with the MLB
 * schedule so the orchestrator's first-pitch cutoff sees the correct state.
 * Does NOT mutate forecasts. Authenticates via `apikey` header.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/refresh-live-actuals")({
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
        const { refreshLiveActuals } = await import(
          "@/lib/automation/live-actuals"
        );

        try {
          const result = await refreshLiveActuals(supabaseAdmin);
          return Response.json(result);
        } catch (e: any) {
          return new Response(
            JSON.stringify({ ok: false, error: e?.message ?? String(e) }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
