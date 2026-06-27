/**
 * pg_cron-driven slate orchestrator endpoint.
 *
 * Called every 2 minutes. Authenticates via the Supabase publishable key in
 * the `apikey` header (same pattern as `/api/public/hooks/lock-live-forecasts`).
 * `/api/public/*` bypasses our auth gate, so verification happens here.
 *
 * Idempotent: all guards (eligibility, cutoff, locked-skip, same-input-hash
 * no-op) live in `runRefresh` and `publishForecastIfEligible`.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/orchestrate-slate")({
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
        const { orchestrateDiamondSlate } = await import(
          "@/lib/automation/orchestrator"
        );

        try {
          const result = await orchestrateDiamondSlate(supabaseAdmin);
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
