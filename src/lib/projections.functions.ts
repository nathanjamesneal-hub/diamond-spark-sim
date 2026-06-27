/**
 * Public read functions for the Diamond forecasting platform.
 * No bearer required — these power the public dashboards.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAppMember } from "@/integrations/supabase/member-middleware";
import { todayInAppTz } from "@/lib/timezone";
import { gameHasStartedOrPastStart } from "@/lib/forecast/window";
import {
  getMarketSimulationMetrics,
  type MarketKey,
  type SimulationMetrics,
} from "@/lib/forecast/sim-metrics";

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
          // Public read paths must only surface OFFICIAL forecasts.
          // Preview rows (admin-only) and legacy_unverified rows
          // (pre-lifecycle) are filtered out.
          .eq("projection_class", "official")
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
      // Player detail card is a public read — never surface preview
      // or legacy_unverified projection history.
      .eq("projection_class", "official")
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

/**
 * Game display state derived from `games.game_status` (MLB enum).
 *   upcoming — scheduled, warmup, delayed start (pregame)
 *   live     — in progress / manager challenge / suspended after start
 *   final    — final, game over, completed
 *   other    — postponed, cancelled, off (treated as not-on-slate)
 */
export type GameDisplayState = "upcoming" | "live" | "final" | "other";

/**
 * Public Forecast Board status. Derived from forecast_runs.status
 * (published|locked|superseded) + GameDisplayState. NEVER includes preview.
 *   no_official — no published/locked official forecast exists yet
 *   published   — official forecast published, game still pregame
 *   locked      — official forecast locked at first pitch, game pregame edge case
 *   live        — official forecast locked, game in progress
 *   final       — official forecast locked, game ended
 */
export type ForecastBoardStatus = "no_official" | "published" | "locked" | "live" | "final" | "preview";

export type ForecastActuals = {
  hits: number | null;
  ab: number | null;
  total_bases: number | null;
  home_runs: number | null;
  rbis: number | null;
  stolen_bases: number | null;
  walks: number | null;
  strikeouts: number | null;
  plate_appearances: number | null;
  runs: number | null;
};

export type PersistedStatDist = {
  mean?: number | null;
  p10?: number | null;
  p50?: number | null;
  p90?: number | null;
  stdev?: number | null;
  probAtLeast1?: number | null;
  probAtLeast2?: number | null;
};
export type PersistedDistributions = Record<string, PersistedStatDist>;

export type DiamondHitterCard = {

  player_id: string;
  mlb_id: number | null;
  player_name: string;
  team_abbrev: string;
  opp_abbrev: string;
  game_id: string;
  mlb_game_id: number | null;
  game_status: string | null;
  game_display_state: GameDisplayState;
  first_pitch_at: string | null;
  batting_order: number | null;
  lineup_status: "locked" | "verified" | "waiting";
  lineup_source: string | null;
  lineup_confidence: number | null;
  badge: LineupBadgeStatus;
  last_refresh_at: string | null;
  source_count: number | null;
  model_version: string;
  projection_class: "official" | "preview";
  forecast_run_id: string | null;
  forecast_status: ForecastBoardStatus;
  forecast_locked_at: string | null;
  forecast_published_at: string | null;
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
  /** Means pulled by getMarketSimulationMetrics from the selected snapshot (no live sim). */
  hit_mean: number | null;
  hr_mean: number | null;
  tb_mean: number | null;
  rbi_mean: number | null;
  /** PA from getMarketSimulationMetrics when persisted; null when unavailable. */
  projected_pa: number | null;
  /**
   * Persisted Monte Carlo distributions from the SELECTED snapshot
   * (sim_snapshot.distributions for this exact projections row). Read-only
   * passthrough so the UI / consensus can extract market means without
   * crossing snapshots from different runs.
   */
  distributions: PersistedDistributions | null;
  /** Source of `distributions`: selected FPP first, then selected projections.sim_snapshot. */
  distributions_source: "fpp" | "sim_snapshot" | null;
  /** Exact selected forecast inputs for the shared read-only normalizer. */
  selected_forecast: {
    forecastRunId: string | null;
    projectionClass: "official" | "preview";
    fppDistributions: PersistedDistributions | null;
    projectionSimSnapshot: Record<string, any> | null;
  };
  sim_metrics: Partial<Record<MarketKey, SimulationMetrics>>;
  inputs_narrative: string | null;
  actual: ForecastActuals | null;


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
  game_display_state: GameDisplayState;
  first_pitch_at: string | null;
  model_version: string;
  projection_class: "official" | "preview";
  forecast_run_id: string | null;
  forecast_status: ForecastBoardStatus;
  forecast_locked_at: string | null;
  forecast_published_at: string | null;
  diamond_score: number | null;
  confidence: number | null;
  projected_outs: number | null;
  /** Means from getMarketSimulationMetrics. */
  k_mean: number | null;
  bb_mean: number | null;
  er_mean: number | null;
  h_mean: number | null;
  /** Batters Faced from getMarketSimulationMetrics when persisted; null when unavailable. */
  projected_bf: number | null;
  /** Persisted Monte Carlo distributions from the SELECTED snapshot. */
  distributions: PersistedDistributions | null;
  distributions_source: "fpp" | "sim_snapshot" | null;
  selected_forecast: {
    forecastRunId: string | null;
    projectionClass: "official" | "preview";
    fppDistributions: PersistedDistributions | null;
    projectionSimSnapshot: Record<string, any> | null;
  };
  sim_metrics: Partial<Record<MarketKey, SimulationMetrics>>;

  quality_start_probability: number | null;
  pitcher_win_probability: number | null;
  inputs_narrative: string | null;
  pitcher_components: PitcherComponentSnapshot[];
  pitcher_fallbacks: string[];
  lineup_confidence: number | null;
  lineup_source: string | null;
  badge: LineupBadgeStatus;
  actual: ForecastActuals | null;
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

    const [{ data: lineups }, { data: pitchers }, { data: projectionsAll }, { data: glsRows }, { data: forecastRunRows }, { data: actualRows }] = await Promise.all([
      sb.from("lineups")
        .select("game_id, player_id, team_id, batting_order, locked_at, confirmed, lineup_status, lineup_source")
        .in("game_id", gameIds),
      sb.from("starting_pitchers")
        .select("game_id, player_id, team_id, confirmed")
        .in("game_id", gameIds),
      sb.from("projections")
        .select("player_id, game_id, model_version, diamond_score, contact_score, power_score, speed_score, pitcher_grade, matchup_grade, confidence, hit_probability, total_base_probability, hr_probability, rbi_probability, run_probability, sb_probability, pitcher_win_probability, quality_start_probability, projected_outs, projection_role, inputs, sim_snapshot, created_at, projection_status, projection_class")
        .in("game_id", gameIds)
        .eq("projection_status", "active")
        // EMERGENCY READ-LAYER: include preview snapshots so pregame
        // Diamond Scores can render before official forecasts publish.
        // Display priority (per (game, player, role, model_version)):
        //   official  > preview (only when game has NOT started)
        // Enforced when building hitter/pitcher rows below.
        .in("projection_class", ["official", "preview"])
        .order("created_at", { ascending: false }),

      sb.from("game_lineup_status")
        .select("game_id, status, confidence, primary_source, source_count, hitters_set, hitters_expected, last_refresh_at")
        .in("game_id", gameIds),

      // Forecast lifecycle status per (game, model_version, class). Filter to
      // the public-visible selected runs: official published/locked, or
      // preview published/locked for pregame fallback.
      sb.from("forecast_runs")
        .select("id, game_id, model_version, status, locked_at, generated_at, projection_class, superseded_by")
        .in("game_id", gameIds)
        .is("superseded_by", null)
        .in("projection_class", ["official", "preview"])
        .in("status", ["published", "locked"]),

      // Final / in-progress box-score actuals for the actual column.
      sb.from("projection_results")
        .select("game_id, player_id, hits, total_bases, home_runs, rbis, stolen_bases, walks, strikeouts, plate_appearances, runs")
        .in("game_id", gameIds),
    ]);

    const glsByGame = new Map((glsRows ?? []).map((r: any) => [r.game_id, r]));
    const runByKey = new Map<string, any>();
    for (const r of forecastRunRows ?? []) {
      runByKey.set(`${r.game_id}:${r.model_version}:${r.projection_class}`, r);
    }
    const fppDistByKey = new Map<string, PersistedDistributions>();
    const runIds = (forecastRunRows ?? []).map((r: any) => r.id).filter(Boolean);
    if (runIds.length > 0) {
      const { data: fppRows } = await sb
        .from("forecast_player_projections")
        .select("forecast_run_id, player_id, role, distributions")
        .in("forecast_run_id", runIds);
      for (const r of fppRows ?? []) {
        const role = (r as any).role === "pitcher" ? "pitcher" : "hitter";
        const dist = ((r as any).distributions ?? null) as PersistedDistributions | null;
        if (dist && Object.keys(dist).length > 0) {
          fppDistByKey.set(`${(r as any).forecast_run_id}:${(r as any).player_id}:${role}`, dist);
        }
      }
    }
    const actualByKey = new Map<string, any>();
    for (const a of actualRows ?? []) {
      actualByKey.set(`${a.player_id}:${a.game_id}`, a);
    }

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

    // Latest projection per (player, game, role, model_version, class) —
    // newest wins (input is DESC by created_at). Role normalized so legacy
    // null/"batter" rows map to "hitter".
    const normRole = (r: string | null | undefined) => (r === "pitcher" ? "pitcher" : "hitter");
    const latestOfficial = new Map<string, any>();
    const latestPreview = new Map<string, any>();
    for (const p of projections) {
      const k = `${p.player_id}:${p.game_id}:${normRole(p.projection_role)}:${p.model_version}`;
      const bucket = p.projection_class === "preview" ? latestPreview : latestOfficial;
      if (!bucket.has(k)) bucket.set(k, p);
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

    const gameStateOf = (status: string | null | undefined): GameDisplayState => {
      const s = (status ?? "").toLowerCase();
      if (!s || s.includes("scheduled") || s.includes("warmup") || s.includes("pre-game") || s.includes("pregame") || s.includes("delayed start")) return "upcoming";
      if (s.includes("final") || s.includes("game over") || s.includes("completed")) return "final";
      if (s.includes("postponed") || s.includes("cancelled") || s.includes("canceled") || s.includes("suspended ")) return "other";
      if (s.includes("in progress") || s.includes("live") || s.includes("manager challenge") || s.includes("delayed") || s.includes("suspended") || s.includes("review")) return "live";
      return "upcoming";
    };

    const forecastStatusOf = (run: any | undefined, gs: GameDisplayState): ForecastBoardStatus => {
      if (!run) return "no_official";
      // Once the game has started, the forecast is functionally locked even
      // if the row hasn't flipped yet (the lock-live cron runs once a minute).
      if (gs === "final") return "final";
      if (gs === "live") return "live";
      if (run.status === "locked") return "locked";
      return "published";
    };

    const snapMean = (snap: any, key: string): number | null => {
      const d = snap?.distributions?.[key];
      const v = d?.mean;
      return typeof v === "number" && isFinite(v) ? v : null;
    };

    const buildHitterActuals = (a: any | undefined): ForecastActuals | null => {
      if (!a) return null;
      const hits = a.hits ?? null;
      const pa = a.plate_appearances ?? null;
      const bb = a.walks ?? null;
      const ab = pa != null && bb != null ? Math.max(0, pa - bb) : null;
      return {
        hits, ab, total_bases: a.total_bases ?? null, home_runs: a.home_runs ?? null,
        rbis: a.rbis ?? null, stolen_bases: a.stolen_bases ?? null, walks: bb,
        strikeouts: a.strikeouts ?? null, plate_appearances: pa, runs: a.runs ?? null,
      };
    };

    // Resolve display projection per (player, game, role, version):
    //   1) latest active official      → forecast_status from forecast_runs/game state
    //   2) latest active preview, ONLY when game has NOT started
    //   3) otherwise no row
    let previewRowsReturned = 0;
    let officialRowsReturned = 0;
    const resolveDisplay = (
      playerId: string,
      gameId: string,
      role: "hitter" | "pitcher",
      version: string,
      gs: GameDisplayState,
      gameStarted: boolean,
    ): { proj: any | null; chosenClass: "official" | "preview" | null } => {
      const k = `${playerId}:${gameId}:${role}:${version}`;
      const official = latestOfficial.get(k);
      if (official) return { proj: official, chosenClass: "official" };
      if (gameStarted) return { proj: null, chosenClass: null };
      const preview = latestPreview.get(k);
      if (preview) return { proj: preview, chosenClass: "preview" };
      // Game not started + no active forecast in either class. Mirror prior
      // behavior of rendering a placeholder row for confirmed lineup spots,
      // but only when at least one official exists for some version (rare).
      void gs;
      return { proj: null, chosenClass: null };
    };

    const hitters: DiamondHitterCard[] = [];
    for (const l of lineups ?? []) {
      const g = gameById.get(l.game_id);
      if (!g) continue;
      const gls = glsByGame.get(l.game_id);
      const oppTeamId = l.team_id === g.home_team_id ? g.away_team_id : g.home_team_id;
      const gs = gameStateOf(g.game_status);
      const gameStarted = gameHasStartedOrPastStart(g.game_status, g.first_pitch_at);
      // Versions present in either bucket for this player/game/hitter slot.
      const versionSet = new Set<string>();
      for (const p of projections) {
        if (p.player_id === l.player_id && p.game_id === l.game_id && normRole(p.projection_role) === "hitter") {
          versionSet.add(p.model_version);
        }
      }
      const versionList = versionSet.size ? Array.from(versionSet) : (activeVersion ? [activeVersion] : []);
      for (const v of versionList) {
        const { proj, chosenClass } = resolveDisplay(l.player_id, l.game_id, "hitter", v, gs, gameStarted);
        // Skip rendering rows with no resolvable forecast (post-cutoff with no official).
        if (!proj) continue;
        if (chosenClass === "preview") previewRowsReturned += 1;
        else officialRowsReturned += 1;
        const run = chosenClass === "official" ? runByKey.get(`${l.game_id}:${v}`) : undefined;
        const snap = proj?.sim_snapshot ?? null;
        const fStatus: ForecastBoardStatus = chosenClass === "preview" ? "preview" : forecastStatusOf(run, gs);
        hitters.push({
          player_id: l.player_id,
          mlb_id: playerMlbId.get(l.player_id) ?? null,
          player_name: playerName.get(l.player_id) ?? "Unknown",
          team_abbrev: teamAbbrev.get(l.team_id ?? "") ?? "",
          opp_abbrev: oppTeamId ? teamAbbrev.get(oppTeamId) ?? "" : "",
          game_id: l.game_id,
          mlb_game_id: g.mlb_game_id ?? null,
          game_status: g.game_status ?? null,
          game_display_state: gs,
          first_pitch_at: g.first_pitch_at ?? null,
          batting_order: l.batting_order ?? null,
          lineup_status: l.locked_at ? "locked" : l.confirmed ? "verified" : "waiting",
          lineup_source: l.lineup_source ?? gls?.primary_source ?? null,
          lineup_confidence: gls?.confidence ?? null,
          badge: badgeFor(gls?.confidence ?? null, !!l.locked_at),
          last_refresh_at: gls?.last_refresh_at ?? null,
          source_count: gls?.source_count ?? null,
          model_version: v,
          forecast_run_id: run?.id ?? null,
          forecast_status: fStatus,
          forecast_locked_at: run?.locked_at ?? null,
          forecast_published_at: run?.generated_at ?? null,
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
          hit_mean: snapMean(snap, "H"),
          hr_mean: snapMean(snap, "HR"),
          tb_mean: snapMean(snap, "TB"),
          rbi_mean: snapMean(snap, "RBI"),
          distributions: (snap?.distributions ?? null) as PersistedDistributions | null,
          distributions_source: snap?.distributions ? "sim_snapshot" : null,

          projected_pa: (() => {
            const pa = snap?.distributions?.PA?.mean ?? snap?.projected_pa ?? null;
            return typeof pa === "number" && isFinite(pa) ? pa : null;
          })(),
          inputs_narrative: narrativeFromInputs(proj?.inputs),
          actual: buildHitterActuals(actualByKey.get(`${l.player_id}:${l.game_id}`)),
        });
      }
    }


    const pitcherCards: DiamondPitcherCard[] = [];
    for (const sp of pitchers ?? []) {
      const g = gameById.get(sp.game_id);
      if (!g) continue;
      const gls = glsByGame.get(sp.game_id);
      const oppTeamId = sp.team_id === g.home_team_id ? g.away_team_id : g.home_team_id;
      const gs = gameStateOf(g.game_status);
      const gameStarted = gameHasStartedOrPastStart(g.game_status, g.first_pitch_at);
      const versionSet = new Set<string>();
      for (const p of projections) {
        if (p.player_id === sp.player_id && p.game_id === sp.game_id && normRole(p.projection_role) === "pitcher") {
          versionSet.add(p.model_version);
        }
      }
      const versionList = versionSet.size ? Array.from(versionSet) : (activeVersion ? [activeVersion] : []);
      for (const v of versionList) {
        const { proj, chosenClass } = resolveDisplay(sp.player_id, sp.game_id, "pitcher", v, gs, gameStarted);
        if (!proj) continue;
        if (chosenClass === "preview") previewRowsReturned += 1;
        else officialRowsReturned += 1;
        const run = chosenClass === "official" ? runByKey.get(`${sp.game_id}:${v}`) : undefined;
        const snap = proj?.sim_snapshot ?? null;
        const fStatus: ForecastBoardStatus = chosenClass === "preview" ? "preview" : forecastStatusOf(run, gs);
        pitcherCards.push({
          player_id: sp.player_id,
          mlb_id: playerMlbId.get(sp.player_id) ?? null,
          player_name: playerName.get(sp.player_id) ?? "Unknown",
          team_abbrev: teamAbbrev.get(sp.team_id ?? "") ?? "",
          opp_abbrev: oppTeamId ? teamAbbrev.get(oppTeamId) ?? "" : "",
          game_id: sp.game_id,
          mlb_game_id: g.mlb_game_id ?? null,
          game_status: g.game_status ?? null,
          game_display_state: gs,
          first_pitch_at: g.first_pitch_at ?? null,
          model_version: v,
          forecast_run_id: run?.id ?? null,
          forecast_status: fStatus,
          forecast_locked_at: run?.locked_at ?? null,
          forecast_published_at: run?.generated_at ?? null,
          diamond_score: proj?.diamond_score ?? null,
          confidence: proj?.confidence ?? null,
          projected_outs: proj?.projected_outs ?? null,
          k_mean: snapMean(snap, "K"),
          bb_mean: snapMean(snap, "BB"),
          er_mean: snapMean(snap, "ER"),
          h_mean: snapMean(snap, "H"),
          projected_bf: (() => {
            const bf = (snap as any)?.distributions?.BF?.mean ?? (snap as any)?.projected_bf ?? null;
            return typeof bf === "number" && isFinite(bf) ? bf : null;
          })(),
          distributions: (snap?.distributions ?? null) as PersistedDistributions | null,
          distributions_source: snap?.distributions ? "sim_snapshot" : null,

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
          actual: buildHitterActuals(actualByKey.get(`${sp.player_id}:${sp.game_id}`)),
        });
      }
    }

    hitters.sort((a, b) => (b.diamond_score ?? -1) - (a.diamond_score ?? -1));
    pitcherCards.sort((a, b) => (b.diamond_score ?? -1) - (a.diamond_score ?? -1));

    console.info(
      `[getDiamondScores] date=${date} version=${activeVersion} official=${officialRowsReturned} preview=${previewRowsReturned} total=${hitters.length + pitcherCards.length}`,
    );


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

// =================== Forecast Board: lazy detail loader ===================
//
// Reads only persisted snapshot data for a single (player, game, model).
// NEVER triggers simulation, lifecycle publishing, or lineup refresh.

export type ForecastDetailDistribution = {
  mean: number | null;
  p50: number | null;
  p90: number | null;
  probAtLeast1: number | null;
  probAtLeast2: number | null;
};

export type ForecastBoardDetail = {
  player: { id: string; mlb_id: number | null; name: string; team_abbrev: string; opp_abbrev: string };
  game: { id: string; mlb_game_id: number | null; first_pitch_at: string | null; venue: string | null; game_status: string | null };
  forecast: {
    run_id: string | null;
    status: ForecastBoardStatus;
    model_version: string;
    locked_at: string | null;
    published_at: string | null;
    projection_role: "hitter" | "pitcher";
  };
  /** Alpha raw + calibrated probability — only present when persisted in this snapshot. */
  calibration: {
    alpha_raw_probability: number | null;
    calibrated_probability: number | null;
    calibration_version: string | null;
  };
  /** Reshaped sim_snapshot.distributions. Unavailable keys are undefined. */
  distributions: Record<string, ForecastDetailDistribution>;
  diamond: {
    score: number | null;
    confidence: number | null;
    contact: number | null;
    power: number | null;
    speed: number | null;
    pitcher_grade: number | null;
    matchup_grade: number | null;
    pitcher_components: PitcherComponentSnapshot[];
    pitcher_fallbacks: string[];
  };
  narrative: string | null;
  context: {
    batting_order: number | null;
    opponent_starter_name: string | null;
    park_factor: number | null;
    weather: string | null;
  };
  actual: ForecastActuals | null;
};

export const getForecastBoardDetail = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator((data: { playerId: string; gameId: string; modelVersion?: string }) => {
    if (!data?.playerId || !data?.gameId) throw new Error("playerId and gameId are required");
    return data;
  })
  .handler(async ({ data, context }): Promise<ForecastBoardDetail | null> => {
    const sb = context.supabase;
    const { data: active } = await sb.from("model_versions").select("version").eq("active", true).maybeSingle();
    const modelVersion = data.modelVersion ?? active?.version ?? null;

    let projQ = sb.from("projections")
      .select("player_id, game_id, model_version, projection_role, diamond_score, confidence, contact_score, power_score, speed_score, pitcher_grade, matchup_grade, hit_probability, total_base_probability, hr_probability, rbi_probability, run_probability, sb_probability, pitcher_win_probability, quality_start_probability, projected_outs, sim_snapshot, inputs, created_at")
      .eq("player_id", data.playerId).eq("game_id", data.gameId)
      .eq("projection_status", "active").eq("projection_class", "official");
    if (modelVersion) projQ = projQ.eq("model_version", modelVersion);
    const { data: projRows } = await projQ.order("created_at", { ascending: false }).limit(1);
    const proj: any = projRows?.[0];
    if (!proj) return null;

    const [{ data: gRow }, { data: pRow }, { data: runRow }, { data: actualRow }, { data: lineupRow }, { data: spRows }] = await Promise.all([
      sb.from("games").select("id, mlb_game_id, first_pitch_at, ballpark, weather, game_status, home_team_id, away_team_id").eq("id", data.gameId).maybeSingle(),
      sb.from("players").select("id, name, mlb_id, team_id").eq("id", data.playerId).maybeSingle(),
      sb.from("forecast_runs").select("id, status, locked_at, generated_at, model_version").eq("game_id", data.gameId).eq("model_version", proj.model_version).eq("projection_class", "official").is("superseded_by", null).order("generated_at", { ascending: false }).limit(1).maybeSingle(),
      sb.from("projection_results").select("hits, total_bases, home_runs, rbis, stolen_bases, walks, strikeouts, plate_appearances, runs").eq("player_id", data.playerId).eq("game_id", data.gameId).maybeSingle(),
      sb.from("lineups").select("batting_order, team_id").eq("game_id", data.gameId).eq("player_id", data.playerId).maybeSingle(),
      sb.from("starting_pitchers").select("game_id, player_id, team_id").eq("game_id", data.gameId),
    ]);

    const { data: teamRows } = await sb.from("teams").select("id, abbreviation");
    const teamAbbrev = new Map((teamRows ?? []).map((t) => [t.id, t.abbreviation]));
    const myTeamId = lineupRow?.team_id ?? (pRow as any)?.team_id ?? null;
    const oppTeamId = myTeamId && gRow ? (myTeamId === gRow.home_team_id ? gRow.away_team_id : gRow.home_team_id) : null;

    // Opposing SP (lookup the SP from the other team for hitter context).
    let opposingStarterName: string | null = null;
    const oppSp = (spRows ?? []).find((s: any) => s.team_id === oppTeamId);
    if (oppSp) {
      const { data: spPlayer } = await sb.from("players").select("name").eq("id", oppSp.player_id).maybeSingle();
      opposingStarterName = (spPlayer as any)?.name ?? null;
    }

    const dist: Record<string, ForecastDetailDistribution> = {};
    const distRaw = proj.sim_snapshot?.distributions ?? {};
    for (const k of Object.keys(distRaw)) {
      const d = distRaw[k] ?? {};
      dist[k] = {
        mean: typeof d.mean === "number" ? d.mean : null,
        p50: typeof d.p50 === "number" ? d.p50 : null,
        p90: typeof d.p90 === "number" ? d.p90 : null,
        probAtLeast1: typeof d.probAtLeast1 === "number" ? d.probAtLeast1 : null,
        probAtLeast2: typeof d.probAtLeast2 === "number" ? d.probAtLeast2 : null,
      };
    }

    const inputs = (proj.inputs ?? {}) as Record<string, any>;
    const pc = pitcherComponentsFromInputs(inputs);
    const role: "hitter" | "pitcher" = proj.projection_role === "pitcher" ? "pitcher" : "hitter";

    const gameStateOf = (status: string | null | undefined): GameDisplayState => {
      const s = (status ?? "").toLowerCase();
      if (s.includes("final") || s.includes("game over") || s.includes("completed")) return "final";
      if (s.includes("in progress") || s.includes("live") || s.includes("manager challenge")) return "live";
      return "upcoming";
    };
    const gs = gameStateOf(gRow?.game_status);
    const status: ForecastBoardStatus =
      !runRow ? "no_official"
      : gs === "final" ? "final"
      : gs === "live" ? "live"
      : runRow.status === "locked" ? "locked"
      : "published";

    const a = actualRow as any;
    const hits = a?.hits ?? null;
    const pa = a?.plate_appearances ?? null;
    const bb = a?.walks ?? null;
    const ab = pa != null && bb != null ? Math.max(0, pa - bb) : null;

    return {
      player: {
        id: data.playerId,
        mlb_id: (pRow as any)?.mlb_id ?? null,
        name: (pRow as any)?.name ?? "Unknown",
        team_abbrev: myTeamId ? teamAbbrev.get(myTeamId) ?? "" : "",
        opp_abbrev: oppTeamId ? teamAbbrev.get(oppTeamId) ?? "" : "",
      },
      game: {
        id: data.gameId,
        mlb_game_id: (gRow as any)?.mlb_game_id ?? null,
        first_pitch_at: (gRow as any)?.first_pitch_at ?? null,
        venue: (gRow as any)?.ballpark ?? null,
        game_status: (gRow as any)?.game_status ?? null,
      },
      forecast: {
        run_id: (runRow as any)?.id ?? null,
        status,
        model_version: proj.model_version,
        locked_at: (runRow as any)?.locked_at ?? null,
        published_at: (runRow as any)?.generated_at ?? null,
        projection_role: role,
      },
      calibration: {
        alpha_raw_probability: typeof inputs.alpha_raw_probability === "number" ? inputs.alpha_raw_probability : null,
        calibrated_probability: typeof inputs.calibrated_probability === "number" ? inputs.calibrated_probability : null,
        calibration_version: typeof inputs.calibration_version === "string" ? inputs.calibration_version : null,
      },
      distributions: dist,
      diamond: {
        score: proj.diamond_score ?? null,
        confidence: proj.confidence ?? null,
        contact: proj.contact_score ?? null,
        power: proj.power_score ?? null,
        speed: proj.speed_score ?? null,
        pitcher_grade: proj.pitcher_grade ?? null,
        matchup_grade: proj.matchup_grade ?? null,
        pitcher_components: pc.components,
        pitcher_fallbacks: pc.fallbacks,
      },
      narrative: narrativeFromInputs(inputs),
      context: {
        batting_order: lineupRow?.batting_order ?? null,
        opponent_starter_name: opposingStarterName,
        park_factor: typeof inputs.park_factor === "number" ? inputs.park_factor : null,
        weather: typeof inputs.weather === "string" ? inputs.weather : null,
      },
      actual: a ? {
        hits, ab, total_bases: a.total_bases ?? null, home_runs: a.home_runs ?? null,
        rbis: a.rbis ?? null, stolen_bases: a.stolen_bases ?? null, walks: bb,
        strikeouts: a.strikeouts ?? null, plate_appearances: pa, runs: a.runs ?? null,
      } : null,
    };
  });


