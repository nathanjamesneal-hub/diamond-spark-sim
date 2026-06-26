/**
 * Public read functions for the Diamond forecasting platform.
 * No bearer required — these power the public dashboards.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAppMember } from "@/integrations/supabase/member-middleware";
import { todayInAppTz } from "@/lib/timezone";

function todayIso(): string {
  // App is pinned to America/Chicago — "today" must match what the user sees.
  return todayInAppTz();
}

export type SlateGame = {
  gamePk: number | null;
  game_id: string | null;
  status: string;
  abstractStatus: string | null;
  isFinal: boolean;
  first_pitch_at: string | null;
  home: { abbrev: string; name: string; probablePitcher: string | null };
  away: { abbrev: string; name: string; probablePitcher: string | null };
  lineup_status: "locked" | "verified" | "waiting" | "missing";
  lineup_source: string | null;
  hitters_set: number;
  has_projections: boolean;
};

export type SlateDiagnostics = {
  api_game_count: number;
  api_games_included: number;
  filtered_out: { gamePk: number; reason: string }[];
  db_game_count: number;
  lineup_count: number;
  projection_count: number;
  note: string | null;
};

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
  .middleware([requireAppMember])
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<{
    date: string;
    modelVersion: string | null;
    rows: SlateRow[];
    games: SlateGame[];
    diagnostics: SlateDiagnostics;
  }> => {
    const sb = context.supabase;
    const date = data.date ?? todayIso();

    // ---- 1. Pull the raw MLB schedule for today (CT). Always trust this as truth. ----
    let apiJson: any = null;
    let apiGames: any[] = [];
    try {
      const res = await fetch(
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=team,linescore,probablePitcher`,
        { headers: { accept: "application/json" } },
      );
      if (res.ok) {
        apiJson = await res.json();
        for (const d of apiJson.dates ?? []) for (const g of d.games ?? []) apiGames.push(g);
      } else {
        console.error(`[getTodaysSlate] MLB schedule ${res.status} for ${date}`);
      }
    } catch (err) {
      console.error("[getTodaysSlate] MLB schedule fetch failed", err);
    }
    console.info(`[getTodaysSlate] date=${date} mlb_api_games=${apiGames.length}`);

    const filteredOut: { gamePk: number; reason: string }[] = [];

    const { data: active } = await sb.from("model_versions").select("version").eq("active", true).maybeSingle();
    const version = active?.version ?? null;

    const { data: dbGames } = await sb
      .from("games").select("id, mlb_game_id, first_pitch_at, home_team_id, away_team_id")
      .eq("date", date);
    const dbGameByMlbPk = new Map<number, any>();
    for (const g of dbGames ?? []) if (g.mlb_game_id) dbGameByMlbPk.set(Number(g.mlb_game_id), g);

    const gameIds = (dbGames ?? []).map((g) => g.id);
    const { data: teams } = await sb.from("teams").select("id, abbreviation, name, mlb_team_id");
    const teamAbbrev = new Map((teams ?? []).map((t) => [t.id, t.abbreviation]));

    const { data: lineups } = gameIds.length
      ? await sb
          .from("lineups").select("game_id, player_id, team_id, locked_at, confirmed, lineup_source")
          .in("game_id", gameIds)
      : { data: [] as any[] };

    const { data: projections } = gameIds.length && version
      ? await sb
          .from("projections")
          .select("player_id, game_id, diamond_score, hit_probability, total_base_probability, hr_probability, rbi_probability, run_probability, sb_probability, confidence, created_at")
          .in("game_id", gameIds).eq("model_version", version)
          .eq("projection_status", "active")
          .order("created_at", { ascending: false })
      : { data: [] as any[] };

    // Keep latest projection per (player, game)
    const latestProj = new Map<string, any>();
    for (const p of projections ?? []) {
      const k = `${p.player_id}:${p.game_id}`;
      if (!latestProj.has(k)) latestProj.set(k, p);
    }

    const playerIds = Array.from(new Set((lineups ?? []).map((l: any) => l.player_id)));
    const { data: players } = playerIds.length
      ? await sb.from("players").select("id, name").in("id", playerIds)
      : { data: [] as any[] };
    const playerName = new Map((players ?? []).map((p: any) => [p.id, p.name]));

    const rows: SlateRow[] = (lineups ?? []).map((l: any) => {
      const g = (dbGames ?? []).find((x) => x.id === l.game_id);
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

    // ---- 2. Build a per-game SlateGame list straight from the API ----
    const lineupCountByGame = new Map<string, number>();
    const sourceByGame = new Map<string, string | null>();
    for (const l of lineups ?? []) {
      lineupCountByGame.set(l.game_id, (lineupCountByGame.get(l.game_id) ?? 0) + 1);
      if (!sourceByGame.has(l.game_id)) sourceByGame.set(l.game_id, (l as any).lineup_source ?? null);
    }
    const projGameIds = new Set((projections ?? []).map((p: any) => p.game_id));

    const games: SlateGame[] = [];
    for (const g of apiGames) {
      const abstract = g.status?.abstractGameState ?? null;
      const detailed = g.status?.detailedState ?? abstract ?? "Scheduled";
      // We never filter by status — show everything (Scheduled, Pre-Game, Warmup, Live, Final, Delayed, Postponed).
      // We only flag cancelled/postponed games as informational, but still include them so the user sees them.
      if (detailed === "Cancelled" || detailed === "Postponed") {
        filteredOut.push({ gamePk: g.gamePk, reason: `status=${detailed} (still listed)` });
      }
      const dbg = dbGameByMlbPk.get(Number(g.gamePk));
      const hitters = dbg ? lineupCountByGame.get(dbg.id) ?? 0 : 0;
      const lineup_status: SlateGame["lineup_status"] =
        !dbg ? "missing" : hitters >= 9 ? "verified" : hitters > 0 ? "waiting" : "missing";
      games.push({
        gamePk: g.gamePk,
        game_id: dbg?.id ?? null,
        status: detailed,
        abstractStatus: abstract,
        isFinal: abstract === "Final",
        first_pitch_at: g.gameDate ?? null,
        home: {
          abbrev: g.teams?.home?.team?.abbreviation ?? "",
          name: g.teams?.home?.team?.name ?? "",
          probablePitcher: g.teams?.home?.probablePitcher?.fullName ?? null,
        },
        away: {
          abbrev: g.teams?.away?.team?.abbreviation ?? "",
          name: g.teams?.away?.team?.name ?? "",
          probablePitcher: g.teams?.away?.probablePitcher?.fullName ?? null,
        },
        lineup_status,
        lineup_source: dbg ? sourceByGame.get(dbg.id) ?? null : null,
        hitters_set: hitters,
        has_projections: dbg ? projGameIds.has(dbg.id) : false,
      });
    }

    const note =
      apiGames.length === 0
        ? `MLB API returned zero games for ${date} (CT). Nothing to load.`
        : !version
        ? "No active model_versions row — set one in admin before running the Diamond Engine."
        : (dbGames?.length ?? 0) === 0
        ? `MLB has ${apiGames.length} games today but none have been imported yet — click "Update Today's Slate" / Import Schedule.`
        : rows.length === 0
        ? `Schedule imported but no lineups/projections yet — Diamond engine will publish projections as soon as lineups arrive.`
        : null;

    const diagnostics: SlateDiagnostics = {
      api_game_count: apiGames.length,
      api_games_included: games.length,
      filtered_out: filteredOut,
      db_game_count: dbGames?.length ?? 0,
      lineup_count: lineups?.length ?? 0,
      projection_count: projections?.length ?? 0,
      note,
    };
    console.info(
      `[getTodaysSlate] api=${apiGames.length} db=${dbGames?.length ?? 0} lineups=${lineups?.length ?? 0} projections=${projections?.length ?? 0} rows=${rows.length}`,
    );

    return { date, modelVersion: version, rows, games, diagnostics };
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

export const getCalibration = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .handler(async ({ context }): Promise<{
    rows: CalibrationRow[]; versions: { version: string; active: boolean; release_date: string; notes: string | null }[];
  }> => {
    const sb = context.supabase;
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
  .middleware([requireAppMember])
  .inputValidator((data: { playerId: string }) => data)
  .handler(async ({ data, context }): Promise<PlayerProjectionSnapshot> => {
    const sb = context.supabase;
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

// =================== Diamond Scores (display-only) ===================

export type LineupBadgeStatus = "official" | "aggregated" | "low_confidence" | "locked";

export type DiamondHitterCard = {
  player_id: string;
  mlb_id: number | null;
  player_name: string;
  team_abbrev: string;
  opp_abbrev: string;
  game_id: string;
  mlb_game_id: number | null;
  game_status: string | null;
  first_pitch_at: string | null;
  batting_order: number | null;
  lineup_status: "locked" | "verified" | "waiting";
  lineup_source: string | null;
  lineup_confidence: number | null;
  badge: LineupBadgeStatus;
  last_refresh_at: string | null;
  source_count: number | null;
  model_version: string;
  diamond_score: number | null;
  contact_score: number | null;
  power_score: number | null;
  speed_score: number | null;
  pitcher_grade: number | null;
  matchup_grade: number | null;
  confidence: number | null;
  hit_probability: number | null;
  total_base_probability: number | null;
  hr_probability: number | null;
  rbi_probability: number | null;
  run_probability: number | null;
  sb_probability: number | null;
  inputs_narrative: string | null;
};

export type PitcherComponentSnapshot = {
  label: string;
  key: string;
  value: number;
  weight: number;
  source: "stat" | "environment" | "fallback";
  reason?: string;
};

export type DiamondPitcherCard = {
  player_id: string;
  mlb_id: number | null;
  player_name: string;
  team_abbrev: string;
  opp_abbrev: string;
  game_id: string;
  mlb_game_id: number | null;
  game_status: string | null;
  first_pitch_at: string | null;
  model_version: string;
  diamond_score: number | null;
  confidence: number | null;
  projected_outs: number | null;
  quality_start_probability: number | null;
  pitcher_win_probability: number | null;
  inputs_narrative: string | null;
  pitcher_components: PitcherComponentSnapshot[];
  pitcher_fallbacks: string[];
  lineup_confidence: number | null;
  lineup_source: string | null;
  badge: LineupBadgeStatus;
};


export type DiamondScoresPayload = {
  date: string;
  activeVersion: string | null;
  modelVersions: string[];
  games: { id: string; label: string; mlb_game_id: number | null; confidence: number | null; hitters_set: number; hitters_expected: number; last_refresh_at: string | null; primary_source: string | null; status: string | null }[];
  teams: { id: string; abbrev: string }[];
  hitters: DiamondHitterCard[];
  pitchers: DiamondPitcherCard[];
  missingHitterFields: string[];
  missingPitcherFields: string[];
  slateConfirmed: number;
  slateTotal: number;
};


const MISSING_HITTER_FIELDS = [
  "hit_over_0_5_probability",
  "hit_over_1_5_probability",
  "total_bases_projection",
  "tb_over_0_5_probability",
  "tb_over_1_5_probability",
  "tb_over_2_5_probability",
];
const MISSING_PITCHER_FIELDS = [
  "strikeout_projection",
  "k_over_3_5_probability",
  "k_over_4_5_probability",
  "k_over_5_5_probability",
  "k_over_6_5_probability",
  "earned_runs_projection",
  "er_under_2_5_probability",
  "hits_allowed_projection",
  "walks_projection",
];

function narrativeFromInputs(inputs: unknown): string | null {
  if (!inputs || typeof inputs !== "object") return null;
  const obj = inputs as Record<string, unknown>;
  if (typeof obj.pitcher_narrative === "string") return obj.pitcher_narrative;
  if (typeof obj.narrative === "string") return obj.narrative;
  if (typeof obj.explanation === "string") return obj.explanation;
  if (typeof obj.summary === "string") return obj.summary;
  return null;
}

const PITCHER_COMPONENT_META: Array<{ key: string; label: string; weight: number }> = [
  { key: "strikeoutScore", label: "Strikeout", weight: 0.25 },
  { key: "contactSuppressionScore", label: "Contact suppression", weight: 0.20 },
  { key: "commandScore", label: "Command", weight: 0.15 },
  { key: "runPreventionScore", label: "Run prevention", weight: 0.20 },
  { key: "workloadScore", label: "Workload", weight: 0.10 },
  { key: "winContextScore", label: "Win context", weight: 0.10 },
];

function pitcherComponentsFromInputs(inputs: unknown): {
  components: PitcherComponentSnapshot[];
  fallbacks: string[];
} {
  if (!inputs || typeof inputs !== "object") return { components: [], fallbacks: [] };
  const obj = inputs as Record<string, unknown>;
  const raw = obj.pitcher_components as Record<string, { value?: number; source?: string; reason?: string }> | undefined;
  const fallbacks = Array.isArray(obj.pitcher_fallbacks) ? (obj.pitcher_fallbacks as string[]) : [];
  if (!raw || typeof raw !== "object") return { components: [], fallbacks };
  const components: PitcherComponentSnapshot[] = [];
  for (const meta of PITCHER_COMPONENT_META) {
    const c = raw[meta.key];
    if (!c) continue;
    const source = (c.source === "stat" || c.source === "environment" || c.source === "fallback") ? c.source : "fallback";
    components.push({
      label: meta.label,
      key: meta.key,
      value: typeof c.value === "number" ? c.value : 50,
      weight: meta.weight,
      source,
      reason: typeof c.reason === "string" ? c.reason : undefined,
    });
  }
  return { components, fallbacks };
}

export const getDiamondScores = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<DiamondScoresPayload> => {
    const sb = context.supabase;
    const date = data.date ?? todayIso();

    const { data: active } = await sb.from("model_versions").select("version").eq("active", true).maybeSingle();
    const activeVersion = active?.version ?? null;

    const { data: games } = await sb
      .from("games").select("id, mlb_game_id, first_pitch_at, home_team_id, away_team_id, game_status")
      .eq("date", date);

    const empty: DiamondScoresPayload = {
      date, activeVersion, modelVersions: [], games: [], teams: [],
      hitters: [], pitchers: [],
      missingHitterFields: MISSING_HITTER_FIELDS,
      missingPitcherFields: MISSING_PITCHER_FIELDS,
      slateConfirmed: 0,
      slateTotal: 0,
    };
    if (!games?.length) return empty;

    const gameIds = games.map((g) => g.id);
    const { data: teamsRows } = await sb.from("teams").select("id, abbreviation");
    const teamAbbrev = new Map((teamsRows ?? []).map((t) => [t.id, t.abbreviation]));

    const [{ data: lineups }, { data: pitchers }, { data: projectionsAll }, { data: glsRows }] = await Promise.all([
      sb.from("lineups")
        .select("game_id, player_id, team_id, batting_order, locked_at, confirmed, lineup_status, lineup_source")
        .in("game_id", gameIds),
      sb.from("starting_pitchers")
        .select("game_id, player_id, team_id, confirmed")
        .in("game_id", gameIds),
      sb.from("projections")
        .select("player_id, game_id, model_version, diamond_score, contact_score, power_score, speed_score, pitcher_grade, matchup_grade, confidence, hit_probability, total_base_probability, hr_probability, rbi_probability, run_probability, sb_probability, pitcher_win_probability, quality_start_probability, projected_outs, projection_role, inputs, created_at, projection_status")
        .in("game_id", gameIds)
        .eq("projection_status", "active")
        .order("created_at", { ascending: false }),
      sb.from("game_lineup_status")
        .select("game_id, status, confidence, primary_source, source_count, hitters_set, hitters_expected, last_refresh_at")
        .in("game_id", gameIds),
    ]);

    const glsByGame = new Map((glsRows ?? []).map((r: any) => [r.game_id, r]));

    // Track every model version we observed (for UI version pickers / debug).
    const versions = new Set<string>();
    for (const p of projectionsAll ?? []) versions.add(p.model_version);

    // Leaderboards must render ONE row per (player, game, role). Only emit the
    // active model version — stale rows from older versions (e.g. 0.1.0 left
    // active before the version flip) are preserved in the DB for calibration
    // but excluded from today's current slate.
    const projections = (projectionsAll ?? []).filter((p) =>
      activeVersion ? p.model_version === activeVersion : true,
    );

    // Latest projection per (player, game, model_version) — newest wins (input
    // is ordered DESC by created_at).
    const latest = new Map<string, any>();
    for (const p of projections) {
      const k = `${p.player_id}:${p.game_id}:${p.model_version}`;
      if (!latest.has(k)) latest.set(k, p);
    }

    const playerIds = new Set<string>();
    for (const l of lineups ?? []) playerIds.add(l.player_id);
    for (const sp of pitchers ?? []) playerIds.add(sp.player_id);

    const { data: playerRows } = await sb
      .from("players").select("id, name, team_id, mlb_id")
      .in("id", Array.from(playerIds));
    const playerName = new Map((playerRows ?? []).map((p) => [p.id, p.name]));
    const playerMlbId = new Map((playerRows ?? []).map((p) => [p.id, (p as any).mlb_id ?? null]));

    const gameById = new Map(games.map((g) => [g.id, g]));
    const teamsInPlay = new Map<string, string>();
    for (const g of games) {
      if (g.home_team_id) teamsInPlay.set(g.home_team_id, teamAbbrev.get(g.home_team_id) ?? "");
      if (g.away_team_id) teamsInPlay.set(g.away_team_id, teamAbbrev.get(g.away_team_id) ?? "");
    }

    const gameOptions = games.map((g) => {
      const gls = glsByGame.get(g.id);
      return {
        id: g.id,
        mlb_game_id: g.mlb_game_id ?? null,
        label: `${teamAbbrev.get(g.away_team_id ?? "") ?? "?"} @ ${teamAbbrev.get(g.home_team_id ?? "") ?? "?"}`,
        confidence: gls?.confidence ?? null,
        hitters_set: gls?.hitters_set ?? 0,
        hitters_expected: gls?.hitters_expected ?? 18,
        last_refresh_at: gls?.last_refresh_at ?? null,
        primary_source: gls?.primary_source ?? null,
        status: gls?.status ?? null,
      };
    });

    const badgeFor = (conf: number | null, locked: boolean): LineupBadgeStatus => {
      if (locked) return "locked";
      if (conf == null) return "low_confidence";
      if (conf >= 95) return "official";
      if (conf >= 75) return "aggregated";
      return "low_confidence";
    };

    const hitters: DiamondHitterCard[] = [];
    for (const l of lineups ?? []) {
      const g = gameById.get(l.game_id);
      if (!g) continue;
      const gls = glsByGame.get(l.game_id);
      const oppTeamId = l.team_id === g.home_team_id ? g.away_team_id : g.home_team_id;
      const versionsForPlayer = (projections ?? [])
        .filter((p) => p.player_id === l.player_id && p.game_id === l.game_id);
      const versionSet = new Set(versionsForPlayer.map((p) => p.model_version));
      const versionList = versionSet.size ? Array.from(versionSet) : (activeVersion ? [activeVersion] : []);
      for (const v of versionList) {
        const proj = latest.get(`${l.player_id}:${l.game_id}:${v}`);
        if (proj && proj.projection_role && proj.projection_role !== "hitter" && proj.projection_role !== "batter") continue;
        hitters.push({
          player_id: l.player_id,
          mlb_id: playerMlbId.get(l.player_id) ?? null,
          player_name: playerName.get(l.player_id) ?? "Unknown",
          team_abbrev: teamAbbrev.get(l.team_id ?? "") ?? "",
          opp_abbrev: oppTeamId ? teamAbbrev.get(oppTeamId) ?? "" : "",
          game_id: l.game_id,
          mlb_game_id: g.mlb_game_id ?? null,
          game_status: g.game_status ?? null,
          first_pitch_at: g.first_pitch_at ?? null,
          batting_order: l.batting_order ?? null,
          lineup_status: l.locked_at ? "locked" : l.confirmed ? "verified" : "waiting",
          lineup_source: l.lineup_source ?? gls?.primary_source ?? null,
          lineup_confidence: gls?.confidence ?? null,
          badge: badgeFor(gls?.confidence ?? null, !!l.locked_at),
          last_refresh_at: gls?.last_refresh_at ?? null,
          source_count: gls?.source_count ?? null,
          model_version: v,
          diamond_score: proj?.diamond_score ?? null,
          contact_score: proj?.contact_score ?? null,
          power_score: proj?.power_score ?? null,
          speed_score: proj?.speed_score ?? null,
          pitcher_grade: proj?.pitcher_grade ?? null,
          matchup_grade: proj?.matchup_grade ?? null,
          confidence: proj?.confidence ?? null,
          hit_probability: proj?.hit_probability ?? null,
          total_base_probability: proj?.total_base_probability ?? null,
          hr_probability: proj?.hr_probability ?? null,
          rbi_probability: proj?.rbi_probability ?? null,
          run_probability: proj?.run_probability ?? null,
          sb_probability: proj?.sb_probability ?? null,
          inputs_narrative: narrativeFromInputs(proj?.inputs),
        });
      }
    }

    const pitcherCards: DiamondPitcherCard[] = [];
    for (const sp of pitchers ?? []) {
      const g = gameById.get(sp.game_id);
      if (!g) continue;
      const gls = glsByGame.get(sp.game_id);
      const oppTeamId = sp.team_id === g.home_team_id ? g.away_team_id : g.home_team_id;
      const versionsForPlayer = (projections ?? [])
        .filter((p) => p.player_id === sp.player_id && p.game_id === sp.game_id);
      const versionSet = new Set(versionsForPlayer.map((p) => p.model_version));
      const versionList = versionSet.size ? Array.from(versionSet) : (activeVersion ? [activeVersion] : []);
      for (const v of versionList) {
        const proj = latest.get(`${sp.player_id}:${sp.game_id}:${v}`);
        if (proj && proj.projection_role && proj.projection_role !== "pitcher") continue;
        pitcherCards.push({
          player_id: sp.player_id,
          mlb_id: playerMlbId.get(sp.player_id) ?? null,
          player_name: playerName.get(sp.player_id) ?? "Unknown",
          team_abbrev: teamAbbrev.get(sp.team_id ?? "") ?? "",
          opp_abbrev: oppTeamId ? teamAbbrev.get(oppTeamId) ?? "" : "",
          game_id: sp.game_id,
          mlb_game_id: g.mlb_game_id ?? null,
          game_status: g.game_status ?? null,
          first_pitch_at: g.first_pitch_at ?? null,
          model_version: v,
          diamond_score: proj?.diamond_score ?? null,
          confidence: proj?.confidence ?? null,
          projected_outs: proj?.projected_outs ?? null,
          quality_start_probability: proj?.quality_start_probability ?? null,
          pitcher_win_probability: proj?.pitcher_win_probability ?? null,
          inputs_narrative: narrativeFromInputs(proj?.inputs),
          ...(() => {
            const pc = pitcherComponentsFromInputs(proj?.inputs);
            return { pitcher_components: pc.components, pitcher_fallbacks: pc.fallbacks };
          })(),
          lineup_confidence: gls?.confidence ?? null,
          lineup_source: gls?.primary_source ?? null,
          badge: badgeFor(gls?.confidence ?? null, gls?.status === "locked"),
        });
      }
    }

    hitters.sort((a, b) => (b.diamond_score ?? -1) - (a.diamond_score ?? -1));
    pitcherCards.sort((a, b) => (b.diamond_score ?? -1) - (a.diamond_score ?? -1));

    const slateConfirmed = gameOptions.filter((g) => (g.confidence ?? 0) >= 95).length;
    const slateTotal = gameOptions.length;

    return {
      date,
      activeVersion,
      modelVersions: Array.from(versions).sort(),
      games: gameOptions,
      teams: Array.from(teamsInPlay.entries()).map(([id, abbrev]) => ({ id, abbrev })).sort((a, b) => a.abbrev.localeCompare(b.abbrev)),
      hitters,
      pitchers: pitcherCards,
      missingHitterFields: MISSING_HITTER_FIELDS,
      missingPitcherFields: MISSING_PITCHER_FIELDS,
      slateConfirmed,
      slateTotal,
    };
  });

