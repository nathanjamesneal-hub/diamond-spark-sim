/**
 * Server-only helper: ensure public.games has rows for a given MLB slate date.
 *
 * Idempotent by mlb_game_id. Preserves historical rows — upserts only.
 * Mirrors the schedule branch of `importSchedule` in ingest.functions.ts so
 * the automation orchestrator and admin-click paths share one source of truth.
 *
 * SERVER ONLY. Do not import from client-reachable modules at module scope.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const MLB = "https://statsapi.mlb.com/api/v1";

async function mlb<T>(path: string): Promise<T> {
  const res = await fetch(`${MLB}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`MLB ${res.status}: ${path}`);
  return (await res.json()) as T;
}

export type EnsureScheduleResult = {
  date: string;
  gamesFetched: number;
  teamsUpserted: number;
  gamesUpserted: number;
  inserted: number;
  updated: number;
  error?: string;
};

export async function ensureScheduleForDate(
  supabaseAdmin: SupabaseClient,
  date: string,
): Promise<EnsureScheduleResult> {
  const out: EnsureScheduleResult = {
    date,
    gamesFetched: 0,
    teamsUpserted: 0,
    gamesUpserted: 0,
    inserted: 0,
    updated: 0,
  };

  try {
    const json = await mlb<any>(
      `/schedule?sportId=1&date=${date}&hydrate=team,linescore,venue`,
    );

    const teamUpserts = new Map<number, any>();
    const games: any[] = [];
    for (const d of json.dates ?? []) {
      for (const g of d.games ?? []) {
        for (const side of ["home", "away"] as const) {
          const t = g.teams?.[side]?.team;
          if (t?.id) {
            teamUpserts.set(t.id, {
              mlb_team_id: t.id,
              abbreviation: t.abbreviation ?? t.teamCode ?? "",
              name: t.name ?? t.teamName ?? "",
              league: t.league?.name ?? null,
              division: t.division?.name ?? null,
            });
          }
        }
        games.push({
          mlb_game_id: g.gamePk,
          date,
          ballpark: g.venue?.name ?? null,
          game_status: g.status?.detailedState ?? null,
          first_pitch_at: g.gameDate ?? null,
          _home_mlb: g.teams?.home?.team?.id,
          _away_mlb: g.teams?.away?.team?.id,
        });
      }
    }
    out.gamesFetched = games.length;

    if (teamUpserts.size) {
      const { error } = await supabaseAdmin
        .from("teams")
        .upsert(Array.from(teamUpserts.values()), { onConflict: "mlb_team_id" });
      if (error) throw new Error(`teams upsert: ${error.message}`);
      out.teamsUpserted = teamUpserts.size;
    }

    const { data: teamRows, error: teamsErr } = await supabaseAdmin
      .from("teams")
      .select("id, mlb_team_id");
    if (teamsErr) throw new Error(`teams lookup: ${teamsErr.message}`);
    const teamByMlb = new Map((teamRows ?? []).map((t: any) => [t.mlb_team_id, t.id]));

    const gameRows = games.map((g) => ({
      mlb_game_id: g.mlb_game_id,
      date: g.date,
      ballpark: g.ballpark,
      game_status: g.game_status,
      first_pitch_at: g.first_pitch_at,
      home_team_id: teamByMlb.get(g._home_mlb) ?? null,
      away_team_id: teamByMlb.get(g._away_mlb) ?? null,
    }));

    if (gameRows.length) {
      // Determine which mlb_game_ids already exist so we can report inserts vs updates.
      const ids = gameRows.map((r) => r.mlb_game_id);
      const { data: existing } = await supabaseAdmin
        .from("games")
        .select("mlb_game_id")
        .in("mlb_game_id", ids);
      const existingIds = new Set((existing ?? []).map((r: any) => r.mlb_game_id));
      out.updated = gameRows.filter((r) => existingIds.has(r.mlb_game_id)).length;
      out.inserted = gameRows.length - out.updated;

      const { error } = await supabaseAdmin
        .from("games")
        .upsert(gameRows, { onConflict: "mlb_game_id" });
      if (error) throw new Error(`games upsert: ${error.message}`);
      out.gamesUpserted = gameRows.length;
    }

    return out;
  } catch (e: any) {
    out.error = e?.message ?? String(e);
    return out;
  }
}
