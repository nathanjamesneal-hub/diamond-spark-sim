/**
 * Cron-callable refresh endpoint. Triggered by pg_cron every 15 minutes
 * during MLB lineup hours; safe to call any other time (no-op when no
 * lineup changes are detected). Validates the Supabase anon key from the
 * `apikey` header to ensure the caller is our own pg_net job.
 */
import { createFileRoute } from "@tanstack/react-router";
import { runRefresh } from "@/lib/lineups/refresh.functions";
import { todayInAppTz } from "@/lib/timezone";

export const Route = createFileRoute("/api/public/hooks/refresh-lineups")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const provided = request.headers.get("apikey") ?? "";
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        if (!provided || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        let date = todayInAppTz();
        try {
          const body = await request.json().catch(() => null);
          if (body && typeof body.date === "string") date = body.date;
        } catch {
          /* empty body is fine */
        }

        const summary = await runRefresh(date);
        return Response.json(summary);
      },
    },
  },
});
