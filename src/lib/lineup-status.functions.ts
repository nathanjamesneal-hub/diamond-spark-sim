/**
 * Pipeline visibility for /lineup-status.
 *
 * Public read function (publishable client) for the per-game pipeline status,
 * plus admin-gated per-game mutations: refresh lineups, run engine, lock.
 * No Diamond Engine formula changes — `runEngineForGame` delegates to the
 * existing `runDiamondEngineForGames(date, [gameId])`.
 */
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

function publicClient() {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
  );
}

function todayIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

// ---------- Types ----------

export type PipelineBadge =
  | "missing_schedule"
  | "missing_pitchers"
  | "missing_lineups"
  | "missing_dna"
  | "ready_to_project"
  | "projected"
  | "confirmed"
  | "locked"
  | "projections_available"
  | "no_projections";

export type TeamLineupSide = {
  team_id: string | null;
  team_abbrev: string;
  hitters_set: number;
  lineup_status: "projected" | "confirmed" | "locked" | "missing";
  lineup_source: string | null;
  starting_pitcher_name: string | null;
  starting_pitcher_confirmed: boolean;
};

export type LineupStatusRow = {
  game_id: string;
  mlb_game_id: number | null;
  label: string;                  // "AWY @ HOM"
  first_pitch_at: string | null;
  game_status: string | null;
  locked_at: string | null;
  home: TeamLineupSide;
  away: TeamLineupSide;
  lineup_source: string | null;   // primary
  lineup_confidence: number | null;
  hitters_set: number;            // both sides
  hitters_expected: number;
  dna_hitters_with_data: number;  // non-default DNA among players in lineup
  dna_hitters_total: number;
  last_refresh_at: string | null;
  latest_projection_at: string | null;
  active_projection_count: number;
  projection_model_version: string | null;
  badges: PipelineBadge[];
};

export type LineupStatusSummary = {
  games_scheduled: number;
  games_with_lineups: number;
  games_with_confirmed_lineups: number;
  games_with_starting_pitchers: number;
  games_with_projections: number;
  games_locked: number;
  last_refresh_at: string | null;
  last_engine_run_at: string | null;
};

export type LineupStatusPayload = {
  date: string;
  summary: LineupStatusSummary;
  rows: LineupStatusRow[];
};

// ---------- Read ----------

export const getLineupStatus = createServerFn({ method: "GET" })
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data }): Promise<LineupStatusPayload> => {
    const sb = publicClient();
    const date = data.date ?? todayIso();

    const empty: LineupStatusPayload = {
      date,
      summary: {
        games_scheduled: 0,
        games_with_lineups: 0,
        games_with_confirmed_lineups: 0,
        games_with_starting_pitchers: 0,
        games_with_projections: 0,
        games_locked: 0,
        last_refresh_at: null,
        last_engine_run_at: null,
      },
      rows: [],
    };

    const { data: games } = await sb
      .from("games")
      .select("id, mlb_game_id, first_pitch_at, game_status, home_team_id, away_team_id, lineups_locked_at")
      .eq("date", date)
      .order("first_pitch_at", { ascending: true });

    if (!games?.length) {
      const { data: cron } = await sb
        .from("cron_runs")
        .select("finished_at, engine_ran, started_at")
        .order("started_at", { ascending: false })
        .limit(20);
      empty.summary.last_refresh_at = cron?.[0]?.finished_at ?? null;
      empty.summary.last_engine_run_at = cron?.find((r) => r.engine_ran)?.started_at ?? null;
      return empty;
    }

    const gameIds = games.map((g) => g.id);

    const { data: teamsRows } = await sb.from("teams").select("id, abbreviation");
    const teamAbbrev = new Map((teamsRows ?? []).map((t) => [t.id, t.abbreviation]));

    const [
      { data: lineups },
      { data: sps },
      { data: gls },
      { data: projections },
      { data: cronRuns },
    ] = await Promise.all([
      sb.from("lineups")
        .select("game_id, team_id, player_id, lineup_status, lineup_source, locked_at")
        .in("game_id", gameIds),
      sb.from("starting_pitchers")
        .select("game_id, team_id, player_id, confirmed")
        .in("game_id", gameIds),
      sb.from("game_lineup_status")
        .select("game_id, status, confidence, primary_source, source_count, hitters_set, hitters_expected, last_refresh_at")
        .in("game_id", gameIds),
      sb.from("projections")
        .select("game_id, model_version, created_at")
        .in("game_id", gameIds)
        .eq("projection_status", "active")
        .order("created_at", { ascending: false }),
      sb.from("cron_runs")
        .select("started_at, finished_at, engine_ran")
        .order("started_at", { ascending: false })
        .limit(50),
    ]);

    const playerIds = new Set<string>();
    for (const l of lineups ?? []) playerIds.add(l.player_id);
    for (const sp of sps ?? []) playerIds.add(sp.player_id);

    const [{ data: playerRows }, { data: dnaRows }] = await Promise.all([
      playerIds.size
        ? sb.from("players").select("id, name").in("id", Array.from(playerIds))
        : Promise.resolve({ data: [] as any[] }),
      playerIds.size
        ? sb.from("player_dna").select("player_id, contact, power, speed, discipline, consistency, last_recomputed_at").in("player_id", Array.from(playerIds))
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const playerName = new Map((playerRows ?? []).map((p: any) => [p.id, p.name]));
    const dnaByPlayer = new Map((dnaRows ?? []).map((d: any) => [d.player_id, d]));

    const isDnaNonDefault = (pid: string): boolean => {
      const d = dnaByPlayer.get(pid);
      if (!d) return false;
      const eq50 = (v: any) => Number(v) === 50;
      const allFifty = eq50(d.contact) && eq50(d.power) && eq50(d.speed) && eq50(d.discipline) && eq50(d.consistency);
      return d.last_recomputed_at != null || !allFifty;
    };

    const glsByGame = new Map((gls ?? []).map((g) => [g.game_id, g]));
    const lineupsByGameTeam = new Map<string, any[]>();
    for (const l of lineups ?? []) {
      const k = `${l.game_id}:${l.team_id ?? ""}`;
      const arr = lineupsByGameTeam.get(k) ?? [];
      arr.push(l);
      lineupsByGameTeam.set(k, arr);
    }
    const spByGameTeam = new Map<string, any>();
    for (const sp of sps ?? []) spByGameTeam.set(`${sp.game_id}:${sp.team_id}`, sp);

    const latestProjByGame = new Map<string, { created_at: string; model_version: string; count: number }>();
    for (const p of projections ?? []) {
      const cur = latestProjByGame.get(p.game_id);
      if (!cur) {
        latestProjByGame.set(p.game_id, { created_at: p.created_at, model_version: p.model_version, count: 1 });
      } else {
        cur.count += 1;
      }
    }

    const rows: LineupStatusRow[] = games.map((g) => {
      const homeLineup = lineupsByGameTeam.get(`${g.id}:${g.home_team_id ?? ""}`) ?? [];
      const awayLineup = lineupsByGameTeam.get(`${g.id}:${g.away_team_id ?? ""}`) ?? [];
      const homeSp = spByGameTeam.get(`${g.id}:${g.home_team_id ?? ""}`);
      const awaySp = spByGameTeam.get(`${g.id}:${g.away_team_id ?? ""}`);
      const gl = glsByGame.get(g.id);
      const proj = latestProjByGame.get(g.id);

      const sideFor = (
        teamId: string | null,
        lp: any[],
        sp: any,
      ): TeamLineupSide => {
        let status: TeamLineupSide["lineup_status"] = "missing";
        if (lp.length) {
          if (lp.some((l) => l.locked_at) || g.lineups_locked_at) status = "locked";
          else if (lp.some((l) => l.lineup_status === "confirmed")) status = "confirmed";
          else status = "projected";
        }
        return {
          team_id: teamId,
          team_abbrev: teamId ? teamAbbrev.get(teamId) ?? "?" : "?",
          hitters_set: lp.length,
          lineup_status: status,
          lineup_source: lp[0]?.lineup_source ?? null,
          starting_pitcher_name: sp ? playerName.get(sp.player_id) ?? "—" : null,
          starting_pitcher_confirmed: !!sp?.confirmed,
        };
      };

      const home = sideFor(g.home_team_id, homeLineup, homeSp);
      const away = sideFor(g.away_team_id, awayLineup, awaySp);

      const allLineup = [...homeLineup, ...awayLineup];
      const dnaCount = allLineup.reduce((n, l) => (isDnaNonDefault(l.player_id) ? n + 1 : n), 0);

      const badges: PipelineBadge[] = [];
      const hasLineups = allLineup.length > 0;
      const hasBothPitchers = !!homeSp && !!awaySp;
      const isLocked = !!g.lineups_locked_at || home.lineup_status === "locked" || away.lineup_status === "locked";
      const isConfirmed = home.lineup_status === "confirmed" || away.lineup_status === "confirmed";

      if (!g.first_pitch_at) badges.push("missing_schedule");
      if (!hasBothPitchers) badges.push("missing_pitchers");
      if (!hasLineups) badges.push("missing_lineups");
      if (allLineup.length && dnaCount === 0) badges.push("missing_dna");
      if (hasLineups && hasBothPitchers && !proj) badges.push("ready_to_project");
      if (isLocked) badges.push("locked");
      else if (isConfirmed) badges.push("confirmed");
      else if (hasLineups) badges.push("projected");
      if (proj && proj.count > 0) badges.push("projections_available");
      else badges.push("no_projections");

      return {
        game_id: g.id,
        mlb_game_id: g.mlb_game_id ?? null,
        label: `${away.team_abbrev} @ ${home.team_abbrev}`,
        first_pitch_at: g.first_pitch_at ?? null,
        game_status: g.game_status ?? null,
        locked_at: g.lineups_locked_at ?? null,
        home,
        away,
        lineup_source: gl?.primary_source ?? home.lineup_source ?? away.lineup_source ?? null,
        lineup_confidence: gl?.confidence ?? null,
        hitters_set: gl?.hitters_set ?? allLineup.length,
        hitters_expected: gl?.hitters_expected ?? 18,
        dna_hitters_with_data: dnaCount,
        dna_hitters_total: allLineup.length,
        last_refresh_at: gl?.last_refresh_at ?? null,
        latest_projection_at: proj?.created_at ?? null,
        active_projection_count: proj?.count ?? 0,
        projection_model_version: proj?.model_version ?? null,
        badges,
      };
    });

    const summary: LineupStatusSummary = {
      games_scheduled: games.length,
      games_with_lineups: rows.filter((r) => r.hitters_set > 0).length,
      games_with_confirmed_lineups: rows.filter(
        (r) => (r.lineup_confidence ?? 0) >= 95 || r.home.lineup_status === "confirmed" || r.away.lineup_status === "confirmed",
      ).length,
      games_with_starting_pitchers: rows.filter((r) => r.home.starting_pitcher_name && r.away.starting_pitcher_name).length,
      games_with_projections: rows.filter((r) => r.active_projection_count > 0).length,
      games_locked: rows.filter((r) => r.locked_at != null).length,
      last_refresh_at: cronRuns?.[0]?.finished_at ?? null,
      last_engine_run_at: cronRuns?.find((r) => r.engine_ran)?.started_at ?? null,
    };

    return { date, summary, rows };
  });

// ---------- Mutations (admin only) ----------

async function dateForGame(gameId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("games").select("date").eq("id", gameId).maybeSingle();
  if (!data?.date) throw new Error("Game not found");
  return data.date as string;
}

async function logCronRun(opts: {
  date: string;
  notes: string;
  gameIds: string[];
  engineRan: boolean;
  projectionsRegenerated?: number;
  error?: string;
  durationMs: number;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("cron_runs").insert({
    started_at: new Date(Date.now() - opts.durationMs).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: opts.durationMs,
    date: opts.date,
    providers: {},
    games_changed: opts.gameIds.length,
    players_changed: 0,
    projections_regenerated: opts.projectionsRegenerated ?? 0,
    affected_game_ids: opts.gameIds,
    engine_ran: opts.engineRan,
    error: opts.error ?? null,
    notes: opts.notes,
  });
}

export const refreshLineupsForGame = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { gameId: string }) => data)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const t0 = Date.now();
    const date = await dateForGame(data.gameId);
    try {
      const { aggregateLineups } = await import("@/lib/lineups/aggregate");
      const agg = await aggregateLineups(date);
      const changed = agg.changedGameIds.includes(data.gameId);
      await logCronRun({
        date,
        notes: `Manual refresh · game ${data.gameId} · ${changed ? "changed" : "no change"}`,
        gameIds: [data.gameId],
        engineRan: false,
        durationMs: Date.now() - t0,
      });
      return { ok: true, changed, providers: agg.providers };
    } catch (e: any) {
      await logCronRun({
        date,
        notes: "Manual refresh failed",
        gameIds: [data.gameId],
        engineRan: false,
        durationMs: Date.now() - t0,
        error: e?.message ?? String(e),
      });
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

export const runEngineForGame = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { gameId: string }) => data)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const t0 = Date.now();
    const date = await dateForGame(data.gameId);
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin
        .from("projections")
        .update({ projection_status: "superseded" })
        .eq("game_id", data.gameId)
        .eq("projection_status", "active");
      const { runDiamondEngineForGames } = await import("@/lib/ingest.functions");
      const out = await runDiamondEngineForGames(date, [data.gameId]);
      await logCronRun({
        date,
        notes: `Manual engine run · game ${data.gameId} · ${out.projectionsInserted} projections`,
        gameIds: [data.gameId],
        engineRan: true,
        projectionsRegenerated: out.projectionsInserted,
        durationMs: Date.now() - t0,
      });
      return { ok: true, ...out };
    } catch (e: any) {
      await logCronRun({
        date,
        notes: "Manual engine run failed",
        gameIds: [data.gameId],
        engineRan: false,
        durationMs: Date.now() - t0,
        error: e?.message ?? String(e),
      });
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

export const lockGame = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { gameId: string }) => data)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const t0 = Date.now();
    const date = await dateForGame(data.gameId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const nowIso = new Date().toISOString();
    await supabaseAdmin.from("games").update({ lineups_locked_at: nowIso }).eq("id", data.gameId);
    await supabaseAdmin.from("lineups").update({ locked_at: nowIso }).eq("game_id", data.gameId);
    await supabaseAdmin
      .from("game_lineup_status")
      .update({ status: "locked" })
      .eq("game_id", data.gameId);
    await logCronRun({
      date,
      notes: `Manual lock · game ${data.gameId}`,
      gameIds: [data.gameId],
      engineRan: false,
      durationMs: Date.now() - t0,
    });
    return { ok: true };
  });

export const unlockGame = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { gameId: string }) => data)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const t0 = Date.now();
    const date = await dateForGame(data.gameId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("games").update({ lineups_locked_at: null }).eq("id", data.gameId);
    await supabaseAdmin.from("lineups").update({ locked_at: null }).eq("game_id", data.gameId);
    await supabaseAdmin
      .from("game_lineup_status")
      .update({ status: "confirmed" })
      .eq("game_id", data.gameId)
      .eq("status", "locked");
    await logCronRun({
      date,
      notes: `Manual unlock · game ${data.gameId}`,
      gameIds: [data.gameId],
      engineRan: false,
      durationMs: Date.now() - t0,
    });
    return { ok: true };
  });
