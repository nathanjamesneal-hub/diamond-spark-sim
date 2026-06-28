/**
 * One-shot admin op exposed via the cron webhook contract so it can be
 * driven without an interactive session. Authenticates via
 * `CRON_WEBHOOK_SECRET` and replaces inflated alpha-0.3 forecasts for the
 * date's UNSTARTED games with fresh `alpha-0.3.1-sample-shrink` runs.
 *
 * Mirrors `replaceInflatedAlphaForUnstartedGames` (serverFn) without the
 * requireSupabaseAuth gate so it can be triggered with the cron secret.
 */
import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { runDiamondEngineForGames } from "@/lib/ingest.functions";
import { todayInAppTz } from "@/lib/timezone";

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

export const Route = createFileRoute("/api/public/hooks/replace-inflated-alpha")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.CRON_WEBHOOK_SECRET ?? "";
        const authHeader = request.headers.get("authorization") ?? "";
        const provided = authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length).trim()
          : "";
        if (!expected || !provided || provided.length !== expected.length) return unauthorized();
        const a = Buffer.from(provided, "utf8");
        const b = Buffer.from(expected, "utf8");
        if (a.length !== b.length || !timingSafeEqual(a, b)) return unauthorized();

        let date = todayInAppTz();
        let gameIds: string[] | undefined;
        try {
          const body = await request.json().catch(() => null);
          if (body && typeof body.date === "string") date = body.date;
          if (body && Array.isArray(body.gameIds)) gameIds = body.gameIds;
        } catch {
          /* empty body is fine */
        }

        const LEGACY = "alpha-0.3";
        const NEW = "alpha-0.3.1-sample-shrink";

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        let q = supabaseAdmin
          .from("games")
          .select("id, mlb_game_id, game_status, first_pitch_at")
          .eq("date", date);
        if (gameIds?.length) q = q.in("id", gameIds);
        const { data: allGames } = await q;
        if (!allGames?.length) {
          return Response.json({
            ok: true, count: 0, details: "No games for date.",
            replacementRuns: 0, supersededLegacyRuns: 0, skippedStartedGames: 0,
            fromVersion: LEGACY, toVersion: NEW,
          });
        }

        const { partitionOpenGames } = await import("@/lib/forecast/window");
        const { open, blocked } = partitionOpenGames(allGames as any[], "replace-inflated-alpha-hook");
        const skippedStartedGames = blocked.length;
        if (!open.length) {
          return Response.json({
            ok: true, count: 0,
            details: `All ${allGames.length} games already started — nothing replaced.`,
            replacementRuns: 0, supersededLegacyRuns: 0, skippedStartedGames,
            fromVersion: LEGACY, toVersion: NEW,
          });
        }

        const openIds = open.map((g: any) => g.id);
        try {
          const r = await runDiamondEngineForGames(date, openIds, NEW, "official");

          let supersededLegacyRuns = 0;
          if (r.projectionsInserted > 0) {
            const { count } = await supabaseAdmin
              .from("projections")
              .update({ projection_status: "superseded" }, { count: "exact" })
              .in("game_id", openIds)
              .eq("model_version", LEGACY)
              .eq("projection_status", "active");
            supersededLegacyRuns = count ?? 0;

            await supabaseAdmin
              .from("forecast_runs")
              .update({ status: "superseded" })
              .in("game_id", openIds)
              .eq("model_version", LEGACY)
              .eq("status", "active");
          }

          return Response.json({
            ok: true,
            count: r.projectionsInserted,
            replacementRuns: r.forecastsPublished,
            supersededLegacyRuns,
            skippedStartedGames,
            openGameIds: openIds,
            fromVersion: LEGACY,
            toVersion: NEW,
            details: `Wrote ${r.projectionsInserted} projections for ${r.gamesEligible} eligible unstarted games as ${NEW}. Superseded ${supersededLegacyRuns} legacy ${LEGACY} active rows. Skipped ${skippedStartedGames} started/locked games.`,
          });
        } catch (e: any) {
          return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
        }
      },
    },
  },
});
