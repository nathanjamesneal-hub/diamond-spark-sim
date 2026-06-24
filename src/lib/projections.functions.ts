/**
 * Public read functions for the Diamond forecasting platform.
 * No bearer required — these power the public dashboards.
 */
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
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

export type SlateRow = {
  player_id: string;
  player_name: string;
  team_abbrev: string;
  opp_abbrev: string;
  game_id: string;
  first_pitch_at: string | null;
  status: "verified" | "waiting" | "locked";
  diamond_score: number | null;
  hit_probability: number | null;
  total_base_probability: number | null;
  hr_probability: number | null;
  rbi_probability: number | null;
  run_probability: number | null;
  sb_probability: number | null;
  confidence: number | null;
};

export const getTodaysSlate = createServerFn({ method: "GET" })
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data }): Promise<{ date: string; modelVersion: string | null; rows: SlateRow[] }> => {
    const sb = publicClient();
    const date = data.date ?? todayIso();

    const { data: active } = await sb.from("model_versions").select("version").eq("active", true).maybeSingle();
    const version = active?.version ?? null;

    const { data: games } = await sb
      .from("games").select("id, first_pitch_at, home_team_id, away_team_id")
      .eq("date", date);
    if (!games?.length || !version) return { date, modelVersion: version, rows: [] };

    const gameIds = games.map((g) => g.id);
    const { data: teams } = await sb.from("teams").select("id, abbreviation");
    const teamAbbrev = new Map((teams ?? []).map((t) => [t.id, t.abbreviation]));

    const { data: lineups } = await sb
      .from("lineups").select("game_id, player_id, team_id, locked_at, confirmed")
      .in("game_id", gameIds);

    const { data: projections } = await sb
      .from("projections")
      .select("player_id, game_id, diamond_score, hit_probability, total_base_probability, hr_probability, rbi_probability, run_probability, sb_probability, confidence, created_at")
      .in("game_id", gameIds).eq("model_version", version)
      .order("created_at", { ascending: false });

    // Keep latest projection per (player, game)
    const latestProj = new Map<string, any>();
    for (const p of projections ?? []) {
      const k = `${p.player_id}:${p.game_id}`;
      if (!latestProj.has(k)) latestProj.set(k, p);
    }

    const { data: players } = await sb
      .from("players").select("id, name")
      .in("id", Array.from(new Set((lineups ?? []).map((l) => l.player_id))));
    const playerName = new Map((players ?? []).map((p) => [p.id, p.name]));

    const rows: SlateRow[] = (lineups ?? []).map((l) => {
      const g = games.find((x) => x.id === l.game_id);
      const oppTeamId = g ? (l.team_id === g.home_team_id ? g.away_team_id : g.home_team_id) : null;
      const proj = latestProj.get(`${l.player_id}:${l.game_id}`);
      const status: SlateRow["status"] = l.locked_at ? "locked" : l.confirmed ? "verified" : "waiting";
      return {
        player_id: l.player_id,
        player_name: playerName.get(l.player_id) ?? "Unknown",
        team_abbrev: teamAbbrev.get(l.team_id ?? "") ?? "",
        opp_abbrev: oppTeamId ? teamAbbrev.get(oppTeamId) ?? "" : "",
        game_id: l.game_id,
        first_pitch_at: g?.first_pitch_at ?? null,
        status,
        diamond_score: proj?.diamond_score ?? null,
        hit_probability: proj?.hit_probability ?? null,
        total_base_probability: proj?.total_base_probability ?? null,
        hr_probability: proj?.hr_probability ?? null,
        rbi_probability: proj?.rbi_probability ?? null,
        run_probability: proj?.run_probability ?? null,
        sb_probability: proj?.sb_probability ?? null,
        confidence: proj?.confidence ?? null,
      };
    });

    rows.sort((a, b) => (b.diamond_score ?? -1) - (a.diamond_score ?? -1));
    return { date, modelVersion: version, rows };
  });

export type CalibrationRow = {
  model_version: string;
  stat: string;
  confidence_bucket: string;
  predicted_mean: number | null;
  observed_mean: number | null;
  brier_score: number | null;
  sample_size: number;
};

export const getCalibration = createServerFn({ method: "GET" }).handler(async (): Promise<{
  rows: CalibrationRow[]; versions: { version: string; active: boolean; release_date: string; notes: string | null }[];
}> => {
  const sb = publicClient();
  const { data: rows } = await sb
    .from("calibration_summary")
    .select("model_version, stat, confidence_bucket, predicted_mean, observed_mean, brier_score, sample_size")
    .order("model_version", { ascending: false });
  const { data: versions } = await sb
    .from("model_versions").select("version, active, release_date, notes")
    .order("release_date", { ascending: false });
  return { rows: (rows ?? []) as CalibrationRow[], versions: (versions ?? []) as any };
});

export type PlayerProjectionSnapshot = {
  player: { id: string; name: string; position: string | null; team_abbrev: string | null } | null;
  dna: { contact: number; power: number; speed: number; discipline: number; consistency: number } | null;
  todays: SlateRow | null;
  history: Array<{
    created_at: string; model_version: string; diamond_score: number | null;
    hit_probability: number | null; hr_probability: number | null;
  }>;
  recent_results: Array<{
    game_id: string; ingested_at: string;
    hits: number; total_bases: number; home_runs: number; rbis: number; stolen_bases: number;
  }>;
};

export const getPlayerProjection = createServerFn({ method: "GET" })
  .inputValidator((data: { playerId: string }) => data)
  .handler(async ({ data }): Promise<PlayerProjectionSnapshot> => {
    const sb = publicClient();
    const { data: player } = await sb
      .from("players").select("id, name, position, team_id").eq("id", data.playerId).maybeSingle();
    if (!player) return { player: null, dna: null, todays: null, history: [], recent_results: [] };

    const { data: team } = player.team_id
      ? await sb.from("teams").select("abbreviation").eq("id", player.team_id).maybeSingle()
      : { data: null };

    const { data: dnaRow } = await sb
      .from("player_dna").select("*").eq("player_id", data.playerId).maybeSingle();

    const { data: history } = await sb
      .from("projections")
      .select("created_at, model_version, diamond_score, hit_probability, hr_probability")
      .eq("player_id", data.playerId)
      .order("created_at", { ascending: false }).limit(30);

    const { data: results } = await sb
      .from("projection_results")
      .select("game_id, ingested_at, hits, total_bases, home_runs, rbis, stolen_bases")
      .eq("player_id", data.playerId)
      .order("ingested_at", { ascending: false }).limit(15);

    return {
      player: {
        id: player.id, name: player.name, position: player.position,
        team_abbrev: team?.abbreviation ?? null,
      },
      dna: dnaRow ? {
        contact: Number(dnaRow.contact), power: Number(dnaRow.power),
        speed: Number(dnaRow.speed), discipline: Number(dnaRow.discipline),
        consistency: Number(dnaRow.consistency),
      } : null,
      todays: null,
      history: (history ?? []) as any,
      recent_results: (results ?? []) as any,
    };
  });
