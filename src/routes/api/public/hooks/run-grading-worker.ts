/**
 * Runs one tick of the immutable grading worker. Reads only snapshot rows;
 * never touches current forecasts. Idempotent.
 *
 * Auth: requires the Supabase anon key in `apikey` header.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/run-grading-worker")({
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
        const { runGradingWorker } = await import("@/lib/grading/writer.server");
        const result = await runGradingWorker(supabaseAdmin as any);
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
