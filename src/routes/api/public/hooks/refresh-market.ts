/**
 * Market-only refresh tick. Recomputes no-vig implied probability and edge
 * against the latest persisted sim distribution for today's slate. Does NOT
 * rerun Monte Carlo.
 *
 * Auth: requires the Supabase publishable key in the `apikey` header.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/refresh-market")({
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
        const { runMarketRefreshForDate } = await import(
          "@/lib/projection-refresh/market.server"
        );
        const { todayInAppTz } = await import("@/lib/timezone");
        const today = todayInAppTz();
        const result = await runMarketRefreshForDate(supabaseAdmin as any, today);
        return Response.json({ ok: true, result, at: new Date().toISOString() });
      },
    },
  },
});
