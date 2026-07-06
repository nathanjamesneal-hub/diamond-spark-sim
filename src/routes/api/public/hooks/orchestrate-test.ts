/**
 * Admin-only orchestrator test harness.
 *
 * POST /api/public/hooks/orchestrate-test
 *   { date?: "YYYY-MM-DD", fault?: { <stage>: "throw" | "timeout" } }
 *
 * Auth: same `apikey` header (Supabase publishable key) as the production
 * orchestrator hook. Meant to be called by hand for verification, not by
 * cron. Runs the real orchestrator with an injected fault so we can prove
 * the log always closes and the next cycle can proceed.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/orchestrate-test")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
            { status: 401, headers: { "Content-Type": "application/json" } });
        }

        let body: any = {};
        try { body = await request.json(); } catch { /* empty body ok */ }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { orchestrateDiamondSlate } = await import("@/lib/automation/orchestrator");

        try {
          const result = await orchestrateDiamondSlate(supabaseAdmin, {
            date: body?.date,
            fault: body?.fault,
            holder: "orchestrate-test",
          });
          return Response.json({ ok: true, result });
        } catch (e: any) {
          // This path should be UNREACHABLE now — the orchestrator's
          // try/finally must always resolve. If we ever see it, the test
          // itself has surfaced a regression.
          return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e), leaked: true }),
            { status: 500, headers: { "Content-Type": "application/json" } });
        }
      },
    },
  },
});
