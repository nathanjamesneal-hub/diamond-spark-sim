/**
 * Runs one tick of the durable Diamond simulation worker.
 *
 * Auth: Supabase publishable/anon key in the `apikey` header.
 * Called every minute by pg_cron. Advances at most `maxJobs` queued/running
 * sim_jobs up to MAX_CHUNKS_PER_TICK chunks each. Idempotent: chunks are
 * resumable, outputs upsert on (sim_job_id, player_id, market), and a job
 * only reaches `completed` after `writeOutputs` returns success.
 *
 * Engine status stays whatever the executed simulator returns (currently
 * scaffold_unvalidated for the placeholder simulator). Never promotes.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/run-sim-worker")({
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
        let body: { maxJobs?: number } = {};
        try { body = await request.json(); } catch { /* empty body is fine */ }
        const maxJobs = Math.min(8, Math.max(1, body.maxJobs ?? 4));

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runWorkerTick } = await import("@/lib/sim-queue/worker.server");
        const result = await runWorkerTick(supabaseAdmin as any, maxJobs);
        return Response.json(result);
      },
    },
  },
});
