/**
 * Cron-callable refresh endpoint. Triggered by pg_cron every 15 minutes
 * during MLB lineup hours. Authenticates via the dedicated
 * `CRON_WEBHOOK_SECRET` (server-only; never leaves the server).
 *
 * Auth: Authorization: Bearer <CRON_WEBHOOK_SECRET>
 *
 * Any other or malformed credential returns a generic 401 without leaking why.
 */
import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { runRefresh } from "@/lib/lineups/refresh.functions";
import { todayInAppTz } from "@/lib/timezone";

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

export const Route = createFileRoute("/api/public/hooks/refresh-lineups")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.CRON_WEBHOOK_SECRET ?? "";
        const authHeader = request.headers.get("authorization") ?? "";
        const provided = authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length).trim()
          : "";

        // Length check before timingSafeEqual (crypto throws on mismatched lengths).
        // Either misconfigured or bad credential → generic 401 with no detail.
        if (!expected || !provided || provided.length !== expected.length) {
          return unauthorized();
        }
        const a = Buffer.from(provided, "utf8");
        const b = Buffer.from(expected, "utf8");
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return unauthorized();
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
