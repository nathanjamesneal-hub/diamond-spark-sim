/**
 * Runs one tick of the durable lock-job worker. Called every minute by
 * pg_cron. Reclaims stale leases then claims and processes due jobs.
 *
 * Auth: requires the Supabase anon key in `apikey` header.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/run-lock-worker")({
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
        const { runLockWorker, reclaimStaleLockLeases } = await import(
          "@/lib/lock-jobs/worker.server"
        );
        const reclaimed = await reclaimStaleLockLeases(supabaseAdmin as any);
        const result = await runLockWorker(supabaseAdmin as any);
        return Response.json({ ok: true, reclaimed, ...result });
      },
    },
  },
});
