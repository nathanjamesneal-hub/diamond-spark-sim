/**
 * Cron/hook entrypoint — build LIVE recommendations for the current slate.
 * Idempotent: creates a new LIVE run and supersedes the previous one.
 */
import { createFileRoute } from "@tanstack/react-router";
import { todayInAppTz } from "@/lib/timezone";

export const Route = createFileRoute("/api/public/hooks/build-recommendations")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json().catch(() => ({} as any));
          const state: "LIVE" | "OFFICIAL" = body?.state === "OFFICIAL" ? "OFFICIAL" : "LIVE";
          const slateDate: string = body?.date ?? todayInAppTz();
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { buildRecommendations } = await import("@/lib/recommendations/build.server");
          if (state === "OFFICIAL") {
            const { data: snaps } = await supabaseAdmin
              .from("engine_beta_snapshots")
              .select("id, game_id")
              .eq("slate_date", slateDate)
              .eq("lock_mode", "automatic")
              .is("lock_reason", null);
            const results = [];
            for (const s of snaps ?? []) {
              results.push(await buildRecommendations(supabaseAdmin, {
                slateDate, state: "OFFICIAL", snapshotId: s.id, gameId: s.game_id,
              }));
            }
            return Response.json({ ok: true, state, results });
          }
          const result = await buildRecommendations(supabaseAdmin, { slateDate, state: "LIVE" });
          return Response.json({ ok: true, state, result });
        } catch (e: any) {
          return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
        }
      },
    },
  },
});
