/**
 * Refresh runner — the single entrypoint used by both the admin
 * "Refresh Now" button and the 15-minute pg_cron job.
 *
 * Steps:
 *   1. Insert a cron_runs row.
 *   2. Run the lineup aggregator (all enabled providers).
 *   3. Refresh probable starting pitchers, capture pitcher diffs.
 *   4. Refresh game_status / postponements from MLB schedule.
 *   5. If nothing changed -> log "No lineup changes detected", return.
 *   6. Otherwise mark prior projections for affected games as superseded
 *      and re-run the Diamond Engine for those games only.
 *   7. Finalize the cron_runs row with timings + counters.
 *
 * Diamond Engine math, registry, calibration: untouched. We only constrain
 * which games it processes by passing `gameIds`.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAppMember } from "@/integrations/supabase/member-middleware";
import { aggregateLineups } from "./aggregate";
import { todayInAppTz } from "@/lib/timezone";

export type RefreshSummary = {
  ok: boolean;
  date: string;
  cronRunId: string | null;
  providers: { id: string; ok: boolean; count: number; durationMs: number; error?: string }[];
  changedGameIds: string[];
  playersChanged: number;
  pitchersChanged: number;
  projectionsRegenerated: number;
  engineRan: boolean;
  durationMs: number;
  error?: string;
};

const MLB = "https://statsapi.mlb.com/api/v1";

async function mlbFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${MLB}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`MLB ${res.status}: ${path}`);
  return (await res.json()) as T;
}

/**
 * Pure runner — called by both the admin server fn and the cron route.
 */
export async function runRefresh(date: string): Promise<RefreshSummary> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const startedAt = new Date();
  const t0 = Date.now();

  // 1. Insert cron_runs row
  const { data: cronRow } = await supabaseAdmin
    .from("cron_runs")
    .insert({ started_at: startedAt.toISOString(), date })
    .select("id")
    .single();
  const cronRunId = cronRow?.id ?? null;

  const summary: RefreshSummary = {
    ok: true,
    date,
    cronRunId,
    providers: [],
    changedGameIds: [],
    playersChanged: 0,
    pitchersChanged: 0,
    projectionsRegenerated: 0,
    engineRan: false,
    durationMs: 0,
  };

  try {
    // 2. Aggregate lineups
    const agg = await aggregateLineups(date);
    summary.providers = agg.providers;
    summary.changedGameIds = [...agg.changedGameIds];
    summary.playersChanged = agg.playersChanged;

    // 3. Refresh game status + probable pitchers from MLB schedule
    const sched = await mlbFetch<any>(
      `/schedule?sportId=1&date=${date}&hydrate=probablePitcher`,
    ).catch(() => null);

    if (sched) {
      const { data: gameRows } = await supabaseAdmin
        .from("games")
        .select("id, mlb_game_id, home_team_id, away_team_id, game_status, lineups_locked_at")
        .eq("date", date);
      const gameByMlb = new Map((gameRows ?? []).map((g: any) => [g.mlb_game_id, g]));

      const { data: prevSps } = await supabaseAdmin
        .from("starting_pitchers")
        .select("game_id, team_id, player_id");
      const prevSpKey = new Set(
        (prevSps ?? []).map((sp: any) => `${sp.game_id}:${sp.team_id}:${sp.player_id}`),
      );

      const pitcherChanges = new Set<string>();

      for (const d of sched.dates ?? []) {
        for (const g of d.games ?? []) {
          const game = gameByMlb.get(g.gamePk);
          if (!game) continue;

          // Update game status + postponements
          const newStatus = g.status?.detailedState ?? game.game_status;
          if (newStatus !== game.game_status) {
            await supabaseAdmin
              .from("games")
              .update({ game_status: newStatus })
              .eq("id", game.id);
          }
          // If game flipped to Final / Postponed, drop from changedGameIds
          if (newStatus === "Final" || newStatus === "Postponed") {
            summary.changedGameIds = summary.changedGameIds.filter((id) => id !== game.id);
          }
          if (game.lineups_locked_at) {
            summary.changedGameIds = summary.changedGameIds.filter((id) => id !== game.id);
            continue;
          }

          for (const side of ["home", "away"] as const) {
            const pp = g.teams?.[side]?.probablePitcher;
            if (!pp?.id) continue;
            const teamId = side === "home" ? game.home_team_id : game.away_team_id;
            if (!teamId) continue;

            await supabaseAdmin.from("players").upsert(
              {
                mlb_id: pp.id,
                name: pp.fullName ?? `Pitcher ${pp.id}`,
                position: "P",
                active: true,
                team_id: teamId,
              },
              { onConflict: "mlb_id" },
            );
            const { data: pRow } = await supabaseAdmin
              .from("players")
              .select("id")
              .eq("mlb_id", pp.id)
              .maybeSingle();
            if (!pRow?.id) continue;

            const key = `${game.id}:${teamId}:${pRow.id}`;
            if (!prevSpKey.has(key)) {
              pitcherChanges.add(game.id);
            }
            await supabaseAdmin.from("starting_pitchers").upsert(
              {
                game_id: game.id,
                team_id: teamId,
                player_id: pRow.id,
                confirmed: true,
              },
              { onConflict: "game_id,team_id" },
            );
          }
        }
      }

      summary.pitchersChanged = pitcherChanges.size;
      for (const id of pitcherChanges) {
        if (!summary.changedGameIds.includes(id)) summary.changedGameIds.push(id);
      }
    }

    // 4. Drop locked or Final games from changed set
    if (summary.changedGameIds.length) {
      const { data: filtered } = await supabaseAdmin
        .from("games")
        .select("id, game_status, lineups_locked_at")
        .in("id", summary.changedGameIds);
      summary.changedGameIds = (filtered ?? [])
        .filter((g: any) => !g.lineups_locked_at && g.game_status !== "Final" && g.game_status !== "Postponed")
        .map((g: any) => g.id);
    }

    // 5. If nothing changed, finish run
    if (summary.changedGameIds.length === 0) {
      summary.durationMs = Date.now() - t0;
      if (cronRunId) {
        await supabaseAdmin
          .from("cron_runs")
          .update({
            finished_at: new Date().toISOString(),
            duration_ms: summary.durationMs,
            providers: summary.providers as any,
            games_changed: 0,
            players_changed: summary.playersChanged,
            projections_regenerated: 0,
            engine_ran: false,
            notes: "No lineup changes detected.",
          })
          .eq("id", cronRunId);
      }
      return summary;
    }

    // 6. Class-scoped supersede: only retire prior OFFICIAL active rows.
    //    Preview/legacy rows are immutable from the refresh pipeline.
    await supabaseAdmin
      .from("projections")
      .update({ projection_status: "superseded" })
      .in("game_id", summary.changedGameIds)
      .eq("projection_status", "active")
      .eq("projection_class", "official");

    // 7. Run engine for affected games only — always OFFICIAL from refresh.
    const { runDiamondEngineForGames } = await import("@/lib/ingest.functions");
    const engineResult = await runDiamondEngineForGames(date, summary.changedGameIds, undefined, "official");

    summary.engineRan = true;
    summary.projectionsRegenerated = engineResult.projectionsInserted;

    summary.durationMs = Date.now() - t0;
    if (cronRunId) {
      await supabaseAdmin
        .from("cron_runs")
        .update({
          finished_at: new Date().toISOString(),
          duration_ms: summary.durationMs,
          providers: summary.providers as any,
          games_changed: summary.changedGameIds.length,
          players_changed: summary.playersChanged,
          projections_regenerated: summary.projectionsRegenerated,
          affected_game_ids: summary.changedGameIds,
          engine_ran: true,
        })
        .eq("id", cronRunId);
    }
    return summary;
  } catch (e: any) {
    summary.ok = false;
    summary.error = e?.message ?? String(e);
    summary.durationMs = Date.now() - t0;
    if (cronRunId) {
      await supabaseAdmin
        .from("cron_runs")
        .update({
          finished_at: new Date().toISOString(),
          duration_ms: summary.durationMs,
          providers: summary.providers as any,
          error: summary.error,
        })
        .eq("id", cronRunId);
    }
    return summary;
  }
}

// Admin-callable server fn
export const refreshLineupsAndProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<RefreshSummary> => {
    // Admin gate
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden: admin role required");

    return runRefresh(data.date ?? todayInAppTz());
  });

// Member-gated read for the admin Cron Status panel.
export const getCronStatus = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .handler(async ({ context }) => {
    const { data: runs } = await context.supabase
      .from("cron_runs")
      .select(
        "id, started_at, finished_at, duration_ms, providers, games_changed, players_changed, projections_regenerated, engine_ran, error, notes, date",
      )
      .order("started_at", { ascending: false })
      .limit(20);

    return { runs: runs ?? [] };
  });
