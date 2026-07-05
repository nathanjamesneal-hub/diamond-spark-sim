// Verification-only hook: run a Diamond V2 form shadow simulation
// for one baseline forecast run. Auth: SUPABASE_PUBLISHABLE_KEY.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/_run-form-shadow-oneshot")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const body = await request.json().catch(() => ({}));
        const forecastRunId: string | undefined = body?.forecastRunId;
        if (!forecastRunId) {
          return Response.json({ ok: false, error: "forecastRunId required" }, { status: 400 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runFormShadowForForecastRun } = await import("@/lib/form-v2/shadow");
        try {
          const result = await runFormShadowForForecastRun(supabaseAdmin as any, forecastRunId);
          return Response.json(result);
        } catch (e: any) {
          return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
        }
      },
    },
  },
});
