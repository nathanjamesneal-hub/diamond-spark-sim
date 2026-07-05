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
  publicationGapGameIds: string[];
  playersChanged: number;
  pitchersChanged: number;
  recentEvents: {
    finalGames: number;
    gameEventRows: number;
    rollupRows: number;
    pitcherHitTypesSourced: boolean;
    error?: string;
  };
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
    publicationGapGameIds: [],
    playersChanged: 0,
    pitchersChanged: 0,
    recentEvents: {
      finalGames: 0,
      gameEventRows: 0,
      rollupRows: 0,
      pitcherHitTypesSourced: false,
    },
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

    // 3b. Refresh Diamond V2 shadow raw recent event counts before any
    // baseline publish can trigger a form-shadow run. This writes only to
    // V2 raw/rollup tables and reads completed official MLB games only.
    try {
      const { refreshRecentEventRatesForDate } = await import("@/lib/form-v2/recent-events");
      const recent = await refreshRecentEventRatesForDate(supabaseAdmin as any, date, 14);
      summary.recentEvents.finalGames = recent.finalGames;
      summary.recentEvents.gameEventRows = recent.gameEventRows;
      summary.recentEvents.rollupRows = recent.rollupRows;
      summary.recentEvents.pitcherHitTypesSourced = recent.pitcherHitTypesSourced;
      if (!recent.ok && recent.error) summary.recentEvents.error = recent.error;
    } catch (e: any) {
      summary.recentEvents.error = e?.message ?? String(e);
    }

    // 4. Drop locked, Final, OR live/started games from the changed set.
    //    First-pitch cutoff applies to the refresh path too — lineup changes
    //    for a game that has already started must NOT trigger the engine.
    if (summary.changedGameIds.length) {
      const { gameHasStartedOrPastStart } = await import("@/lib/forecast/window");
      const { data: filtered } = await supabaseAdmin
        .from("games")
        .select("id, mlb_game_id, game_status, first_pitch_at, lineups_locked_at")
        .in("id", summary.changedGameIds);
      const blocked: Array<{ id: string; mlb_game_id: number | null; game_status: string | null }> = [];
      summary.changedGameIds = (filtered ?? [])
        .filter((g: any) => {
          if (g.lineups_locked_at) return false;
          if (g.game_status === "Final" || g.game_status === "Postponed") return false;
          if (gameHasStartedOrPastStart(g.game_status, g.first_pitch_at)) {
            blocked.push({ id: g.id, mlb_game_id: g.mlb_game_id, game_status: g.game_status });
            return false;
          }
          return true;
        })
        .map((g: any) => g.id);
      for (const b of blocked) {
        // eslint-disable-next-line no-console
        console.log("[forecast.window]", JSON.stringify({
          gamePk: b.mlb_game_id,
          gameStatus: b.game_status,
          action: "runRefresh",
          decision: "forecast_window_closed",
          reason: "lineup change after first pitch ignored",
        }));
      }
    }

    // 4b. PUBLICATION-GAP RECONCILIATION.
    //     Self-healing pass: any pregame, non-locked game on `date` that is
    //     currently eligible for an OFFICIAL forecast but has no active
    //     published/locked forecast_runs row gets added to the engine batch
    //     even when its inputs did not change in this cycle. The downstream
    //     eligibility gate, first-pitch cutoff, locked-skip, and
    //     same-input-hash no-op in publishForecastIfEligible all still apply.
    try {
      const { evaluateOfficialEligibility } = await import("@/lib/forecast/eligibility");
      const { gameHasStartedOrPastStart } = await import("@/lib/forecast/window");
      const { data: activeVersionRow } = await supabaseAdmin
        .from("model_versions").select("version").eq("active", true).maybeSingle();
      const activeVersion = (activeVersionRow as any)?.version ?? null;

      const { data: dayGames } = await supabaseAdmin
        .from("games")
        .select("id, mlb_game_id, home_team_id, away_team_id, game_status, first_pitch_at, lineups_locked_at")
        .eq("date", date);

      const candidateGames = (dayGames ?? []).filter((g: any) =>
        !g.lineups_locked_at &&
        g.game_status !== "Final" &&
        g.game_status !== "Postponed" &&
        !gameHasStartedOrPastStart(g.game_status, g.first_pitch_at),
      );

      if (candidateGames.length && activeVersion) {
        const candidateIds = candidateGames.map((g: any) => g.id);
        const candidatePks = candidateGames.map((g: any) => g.mlb_game_id);

        const [{ data: lns }, { data: ssps }, { data: gls }, { data: runs }] = await Promise.all([
          supabaseAdmin.from("lineups")
            .select("game_id, player_id, team_id, batting_order, lineup_status, lineup_source, confirmed, locked_at")
            .in("game_id", candidateIds),
          supabaseAdmin.from("starting_pitchers")
            .select("game_id, team_id, player_id, confirmed")
            .in("game_id", candidateIds),
          supabaseAdmin.from("game_lineup_status")
            .select("game_id, status, primary_source")
            .in("game_id", candidateIds),
          supabaseAdmin.from("forecast_runs")
            .select("game_pk")
            .in("game_pk", candidatePks)
            .eq("model_version", activeVersion)
            .eq("projection_class", "official")
            .in("status", ["published", "locked"]),
        ]);

        const glsByGame = new Map((gls ?? []).map((r: any) => [r.game_id, r]));
        const publishedPks = new Set((runs ?? []).map((r: any) => r.game_pk));

        for (const g of candidateGames) {
          if (publishedPks.has(g.mlb_game_id)) continue;
          const r = evaluateOfficialEligibility({
            game: g,
            lineups: (lns ?? []).filter((l: any) => l.game_id === g.id) as any[],
            starters: (ssps ?? []).filter((s: any) => s.game_id === g.id) as any[],
            gls: glsByGame.get(g.id),
          });
          if (!r.eligible) continue;
          if (!summary.changedGameIds.includes(g.id)) summary.changedGameIds.push(g.id);
          summary.publicationGapGameIds.push(g.id);
          // eslint-disable-next-line no-console
          console.log("[forecast.lifecycle]", JSON.stringify({
            gamePk: g.mlb_game_id,
            modelVersion: activeVersion,
            decision: "publication_gap_reconciliation",
            triggerReason: "publication_gap_reconciliation",
            message: "eligible game has no active official forecast; adding to engine batch",
          }));
        }
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.log("[forecast.lifecycle]", JSON.stringify({
        decision: "publication_gap_reconciliation_error",
        error: e?.message ?? String(e),
      }));
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
            notes: summary.recentEvents.error
              ? `No lineup changes detected. V2 recent events error: ${summary.recentEvents.error}`
              : "No lineup changes detected.",
            games_changed: 0,
            players_changed: summary.playersChanged,
            projections_regenerated: 0,
            engine_ran: false,
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
          notes: summary.recentEvents.error ? `V2 recent events error: ${summary.recentEvents.error}` : null,
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
