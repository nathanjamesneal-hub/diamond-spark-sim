/**
 * Pure Engine Beta board computation.
 *
 * Takes a supabase client (must have read access to the same public tables
 * the admin `getEngineBetaBoard` reads). No auth, no writes.
 *
 * Shared by:
 *   - getEngineBetaBoard          (admin route)
 *   - lockEngineBetaBoard         (manual date-wide lock)
 *   - lockSingleGameNow           (manual per-game lock)
 *   - autoLockPregameForDate      (orchestrator per-game lock)
 *
 * Score weights, category catalog, and readiness rules are unchanged.
 */
import {
  ENGINE_BETA_CATEGORIES,
  EXCLUDED_CATEGORIES,
  findCategory,
  type EngineBetaCategoryKey,
} from "./categories";
import { computeEngineBetaScore, ENGINE_BETA_WEIGHTS, type ScoreComponents } from "./score";

const RECENT_WINDOW_DAYS = 14;

export type ReadinessState = "ready" | "watch" | "not_ready";

export type BoardRow = {
  playerId: string;
  mlbId: number | null;
  name: string;
  teamAbbr: string | null;
  role: "hitter" | "pitcher";
  gameId: string;
  gamePk: number;
  matchup: string;
  firstPitchAt: string | null;
  gameStatus: string | null;

  forecastRunId: string;
  forecastGeneratedAt: string;
  forecastStatus: string;
  forecastClass: string;

  baselineMean: number | null;
  baselineP50: number | null;
  baselineP90: number | null;
  probAtThreshold: number | null;
  eventLabel: string;
  meanUnit: string;

  shadowRunId: string | null;
  shadowMean: number | null;
  shadowDelta: number | null;

  formApplied: boolean;
  formReason: string;
  formHeadlineEvent: string | null;
  formHeadlineDelta: number | null;
  recentDenominator: number | null;

  lineupState: string;
  battingOrder: number | null;

  readiness: ReadinessState;
  readinessReason: string;

  score: number;
  scoreComponents: ScoreComponents;
};

export type BoardPayload = {
  date: string;
  category: EngineBetaCategoryKey;
  categoryLabel: string;
  eventLabel: string;
  meanUnit: string;
  hasStoredProbAtThreshold: boolean;
  role: "hitter" | "pitcher";
  cohortMean: number | null;
  cohortStdev: number | null;
  scoreWeights: typeof ENGINE_BETA_WEIGHTS;
  rows: BoardRow[];
  excludedCategories: typeof EXCLUDED_CATEGORIES;
  games: Array<{ gameId: string; gamePk: number; matchup: string; firstPitchAt: string | null; gameStatus: string | null }>;
  teams: Array<{ abbr: string; name: string | null }>;
  generatedAt: string;
};

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function extractDistEntry(distributions: any, distKey: string): any | null {
  if (!distributions || typeof distributions !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(distributions, distKey)) return distributions[distKey];
  const lower = distKey.toLowerCase();
  for (const k of Object.keys(distributions)) {
    if (k.toLowerCase() === lower) return distributions[k];
  }
  return null;
}
function meanFromEntry(e: any): number | null {
  if (!e || typeof e !== "object") return null;
  return num(e.mean) ?? num(e.avg) ?? num(e.mu);
}
function probAtLeast1FromEntry(e: any): number | null {
  if (!e || typeof e !== "object") return null;
  return num(e.probAtLeast1) ?? num(e.prob_at_least_1) ?? num(e.prob1Plus) ?? null;
}
function meanStdev(xs: number[]): { mean: number | null; stdev: number | null } {
  const finite = xs.filter((x) => Number.isFinite(x));
  if (!finite.length) return { mean: null, stdev: null };
  const m = finite.reduce((a, b) => a + b, 0) / finite.length;
  if (finite.length < 2) return { mean: m, stdev: null };
  const variance = finite.reduce((a, x) => a + (x - m) * (x - m), 0) / (finite.length - 1);
  return { mean: m, stdev: Math.sqrt(variance) };
}

function computeReadiness(
  role: "hitter" | "pitcher",
  lineupState: string,
  forecastGeneratedAt: string | null,
): { state: ReadinessState; reason: string } {
  const hoursOld = forecastGeneratedAt ? Math.max(0, (Date.now() - Date.parse(forecastGeneratedAt)) / 3_600_000) : Infinity;
  const stale = hoursOld > 36;
  const veryStale = !Number.isFinite(hoursOld) || hoursOld > 72;
  if (role === "hitter") {
    if (lineupState === "missing") return { state: "not_ready", reason: "No lineup slot yet" };
    if (veryStale) return { state: "not_ready", reason: "Forecast >72h old / missing" };
    if (lineupState === "confirmed" || lineupState === "locked") {
      return stale ? { state: "watch", reason: "Confirmed lineup, forecast >36h old" } : { state: "ready", reason: "Confirmed lineup + fresh forecast" };
    }
    return { state: "watch", reason: "Projected lineup slot" };
  }
  if (lineupState === "missing") return { state: "not_ready", reason: "No starter role identified" };
  if (veryStale) return { state: "not_ready", reason: "Forecast >72h old / missing" };
  if (lineupState === "confirmed" || lineupState === "locked") {
    return stale ? { state: "watch", reason: "Confirmed starter, forecast >36h old" } : { state: "ready", reason: "Confirmed starter + fresh forecast" };
  }
  return { state: "watch", reason: "Probable/unconfirmed starter" };
}

const READINESS_RANK: Record<ReadinessState, number> = { ready: 2, watch: 1, not_ready: 0 };

/**
 * Compute a full board payload for `date` + `category`.
 * Optionally filter to a specific set of game IDs (used by per-game lockers).
 */
export async function computeBoardPayload(
  admin: any,
  date: string,
  categoryKey: EngineBetaCategoryKey,
  opts?: { gameIds?: string[] },
): Promise<BoardPayload> {
  const category = findCategory(categoryKey);
  if (!category) throw new Error(`Unsupported category ${categoryKey}`);

  const emptyReturn = (games: any[] = [], teams: any[] = [], matchupOf?: (gid: string) => string): BoardPayload => ({
    date,
    category: categoryKey,
    categoryLabel: category.label,
    eventLabel: category.eventLabel,
    meanUnit: category.meanUnit,
    hasStoredProbAtThreshold: category.hasStoredProbAtThreshold,
    role: category.role,
    cohortMean: null,
    cohortStdev: null,
    scoreWeights: ENGINE_BETA_WEIGHTS,
    rows: [],
    excludedCategories: EXCLUDED_CATEGORIES,
    games: games.map((g: any) => ({
      gameId: g.id,
      gamePk: Number(g.mlb_game_id),
      matchup: matchupOf ? matchupOf(g.id) : "—",
      firstPitchAt: g.first_pitch_at ?? null,
      gameStatus: g.game_status ?? null,
    })),
    teams: teams.map((t: any) => ({ abbr: t.abbreviation, name: t.name })),
    generatedAt: new Date().toISOString(),
  });

  // 1. Slate games (optionally filtered)
  let gamesQuery = admin
    .from("games")
    .select("id, mlb_game_id, first_pitch_at, game_status, home_team_id, away_team_id")
    .eq("date", date);
  if (opts?.gameIds?.length) gamesQuery = gamesQuery.in("id", opts.gameIds);
  const { data: games } = await gamesQuery;
  const gamesList = games ?? [];
  if (!gamesList.length) return emptyReturn();

  const gameIds = gamesList.map((g: any) => g.id);
  const gamePks = gamesList.map((g: any) => Number(g.mlb_game_id));
  const teamIds = Array.from(new Set(gamesList.flatMap((g: any) => [g.home_team_id, g.away_team_id]).filter(Boolean)));
  const { data: teamsRows } = teamIds.length
    ? await admin.from("teams").select("id, name, abbreviation").in("id", teamIds)
    : { data: [] };
  const teamById = new Map<string, any>((teamsRows ?? []).map((t: any) => [String(t.id), t]));
  const gameById = new Map<string, any>(gamesList.map((g: any) => [String(g.id), g]));
  const matchupOf = (gid: string) => {
    const g: any = gameById.get(gid); if (!g) return "—";
    const home = teamById.get(String(g.home_team_id))?.abbreviation ?? "HOM";
    const away = teamById.get(String(g.away_team_id))?.abbreviation ?? "AWY";
    return `${away} @ ${home}`;
  };

  // 2. Best forecast run per game
  const { data: fcRuns } = await admin
    .from("forecast_runs")
    .select("id, game_id, game_pk, projection_class, status, generated_at, locked_at, model_version")
    .in("game_pk", gamePks)
    .eq("slate_date", date);
  const runsByGame = new Map<string, any>();
  for (const r of fcRuns ?? []) {
    const gid = String(r.game_id);
    const rank = (r.status === "locked" ? 3 : r.status === "published" ? 2 : 1) * 1e13
      + Date.parse(r.locked_at ?? r.generated_at ?? "1970-01-01");
    const prev: any = runsByGame.get(gid);
    const prevRank = prev ? (prev.status === "locked" ? 3 : prev.status === "published" ? 2 : 1) * 1e13
      + Date.parse(prev.locked_at ?? prev.generated_at ?? "1970-01-01") : -1;
    if (rank > prevRank) runsByGame.set(gid, r);
  }
  const runIds = Array.from(runsByGame.values()).map((r) => r.id);
  if (!runIds.length) return emptyReturn(gamesList, teamsRows ?? [], matchupOf);

  // 3. Player projections
  const { data: fpp } = await admin
    .from("forecast_player_projections")
    .select("forecast_run_id, player_id, mlb_id, role, distributions")
    .in("forecast_run_id", runIds)
    .eq("role", category.role);

  // 4. Players + teams
  const playerIds = Array.from(new Set((fpp ?? []).map((r: any) => r.player_id).filter(Boolean)));
  const { data: playerRows } = playerIds.length
    ? await admin.from("players").select("id, name, mlb_id, team_id, teams:team_id(id, name, abbreviation)").in("id", playerIds)
    : { data: [] };
  const playerById = new Map((playerRows ?? []).map((p: any) => [String(p.id), p]));

  // 5. Lineups + starters
  const { data: lineupRows } = await admin
    .from("lineups")
    .select("game_id, player_id, batting_order, lineup_status, confirmed")
    .in("game_id", gameIds);
  const lineupByPlayer = new Map<string, any>();
  for (const l of lineupRows ?? []) lineupByPlayer.set(`${l.game_id}:${l.player_id}`, l);
  const { data: starterRows } = await admin
    .from("starting_pitchers")
    .select("game_id, player_id, confirmed, team_id")
    .in("game_id", gameIds);
  const starterByPlayer = new Map<string, any>();
  for (const s of starterRows ?? []) starterByPlayer.set(`${s.game_id}:${s.player_id}`, s);

  // 6. Shadow — latest per game
  const { data: shadowRuns } = await admin
    .from("monte_carlo_form_shadow_runs")
    .select("id, game_id, slate_date, created_at")
    .in("game_id", gameIds)
    .eq("slate_date", date);
  const shadowIdsByGame = new Map<string, string>();
  for (const s of (shadowRuns ?? []).sort((a: any, b: any) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    if (!shadowIdsByGame.has(String(s.game_id))) shadowIdsByGame.set(String(s.game_id), s.id);
  }
  const shadowRunIds = Array.from(shadowIdsByGame.values());
  const { data: shadowOutputs } = shadowRunIds.length
    ? await admin
        .from("monte_carlo_form_shadow_player_outputs")
        .select("shadow_run_id, player_id, role, baseline_distributions, form_distributions, form_adjustments")
        .in("shadow_run_id", shadowRunIds)
        .eq("role", category.role)
    : { data: [] };
  const shadowByPlayer = new Map<string, any>();
  for (const o of shadowOutputs ?? []) shadowByPlayer.set(`${o.shadow_run_id}:${o.player_id}`, o);

  // 7. Recent event rates
  const mlbIds = Array.from(new Set((fpp ?? []).map((r: any) => Number(r.mlb_id)).filter(Boolean)));
  const { data: recent } = mlbIds.length
    ? await admin
        .from("player_recent_event_rates")
        .select("mlb_id, role, pa, bf, as_of_date, window_days")
        .in("mlb_id", mlbIds)
        .eq("role", category.role)
        .eq("window_days", RECENT_WINDOW_DAYS)
        .lte("as_of_date", date)
        .order("as_of_date", { ascending: false })
    : { data: [] };
  const recentByMlb = new Map<number, any>();
  for (const r of recent ?? []) if (!recentByMlb.has(Number(r.mlb_id))) recentByMlb.set(Number(r.mlb_id), r);

  type PreRow = Omit<BoardRow, "score" | "scoreComponents" | "readiness" | "readinessReason"> & { _formDelta: number | null };
  const pre: PreRow[] = [];

  for (const p of fpp ?? []) {
    const run: any = Array.from(runsByGame.values()).find((r) => r.id === p.forecast_run_id);
    if (!run) continue;
    const gid = String(run.game_id);
    const game: any = gameById.get(gid);
    if (!game) continue;
    const player: any = playerById.get(String(p.player_id));
    const teamAbbr = player?.teams?.abbreviation ?? null;

    const baseEntry = extractDistEntry(p.distributions, category.distKey);
    const baselineMean = meanFromEntry(baseEntry);
    const baselineP50 = num(baseEntry?.p50);
    const baselineP90 = num(baseEntry?.p90);
    const baselineProbAtLeast1 = probAtLeast1FromEntry(baseEntry);
    if (baselineMean == null) continue;

    const shadowRunId = shadowIdsByGame.get(gid) ?? null;
    const shadowRow = shadowRunId ? shadowByPlayer.get(`${shadowRunId}:${p.player_id}`) : null;
    const shadowEntry = shadowRow ? extractDistEntry(shadowRow.form_distributions, category.distKey) : null;
    const shadowMean = meanFromEntry(shadowEntry);
    const shadowDelta = shadowMean != null && baselineMean != null ? shadowMean - baselineMean : null;

    const adj = shadowRow?.form_adjustments;
    const formApplied = !!adj?.applied;
    const fields: any[] = Array.isArray(adj?.fields) ? adj.fields : [];
    let headlineEvent: string | null = null;
    let headlineDelta: number | null = null;
    for (const f of fields) {
      if (f?.status !== "applied") continue;
      const d = num(f.appliedDelta);
      if (d == null) continue;
      if (headlineDelta == null || Math.abs(d) > Math.abs(headlineDelta)) {
        headlineDelta = d;
        headlineEvent = String(f.event);
      }
    }
    const formReason = !formApplied
      ? (adj?.reason ? String(adj.reason) : "No form adjustment applied — insufficient recent sample")
      : (headlineEvent && headlineDelta != null
          ? `Recent ${headlineEvent} rate ${headlineDelta > 0 ? "higher" : "lower"} than season baseline`
          : "Recent form within event caps");

    let categoryFormDelta: number | null = null;
    const distEventKey = category.distKey;
    for (const f of fields) {
      if (String(f?.event) === distEventKey && f?.status === "applied") {
        categoryFormDelta = num(f.appliedDelta);
        break;
      }
    }

    let lineupState = "missing";
    let battingOrder: number | null = null;
    if (category.role === "hitter") {
      const l = lineupByPlayer.get(`${gid}:${p.player_id}`);
      if (l) {
        lineupState = l.confirmed ? "confirmed" : (l.lineup_status ?? "projected");
        battingOrder = l.batting_order ?? null;
      }
    } else {
      const s = starterByPlayer.get(`${gid}:${p.player_id}`);
      if (s) lineupState = s.confirmed ? "confirmed" : "unconfirmed";
    }

    const recentRow = recentByMlb.get(Number(p.mlb_id));
    const recentDenominator = category.role === "hitter" ? num(recentRow?.pa) : num(recentRow?.bf);

    pre.push({
      playerId: String(p.player_id),
      mlbId: p.mlb_id != null ? Number(p.mlb_id) : null,
      name: player?.name ?? `MLB ${p.mlb_id ?? "?"}`,
      teamAbbr,
      role: category.role,
      gameId: gid,
      gamePk: Number(game.mlb_game_id),
      matchup: matchupOf(gid),
      firstPitchAt: game.first_pitch_at ?? null,
      gameStatus: game.game_status ?? null,
      forecastRunId: run.id,
      forecastGeneratedAt: run.generated_at,
      forecastStatus: run.status,
      forecastClass: run.projection_class,
      baselineMean, baselineP50, baselineP90,
      probAtThreshold: category.hasStoredProbAtThreshold ? baselineProbAtLeast1 : null,
      eventLabel: category.eventLabel,
      meanUnit: category.meanUnit,
      shadowRunId,
      shadowMean, shadowDelta,
      formApplied, formReason,
      formHeadlineEvent: headlineEvent, formHeadlineDelta: headlineDelta,
      recentDenominator,
      lineupState, battingOrder,
      _formDelta: categoryFormDelta,
    });
  }

  const { mean: cohortMean, stdev: cohortStdev } = meanStdev(pre.map((r) => r.baselineMean!).filter((x) => x != null) as number[]);

  const rows: BoardRow[] = pre.map((r) => {
    const components = computeEngineBetaScore({
      higherIsBetter: category.higherIsBetter,
      baselineMean: r.baselineMean,
      cohortMean, cohortStdev,
      formDelta: r._formDelta,
      lineupState: r.lineupState,
      forecastGeneratedAt: r.forecastGeneratedAt,
      recentDenominator: r.recentDenominator,
    }, category.role);
    const readiness = computeReadiness(category.role, r.lineupState, r.forecastGeneratedAt);
    const { _formDelta, ...rest } = r;
    return { ...rest, readiness: readiness.state, readinessReason: readiness.reason, score: components.total, scoreComponents: components };
  });

  rows.sort((a, b) => (READINESS_RANK[b.readiness] - READINESS_RANK[a.readiness]) || (b.score - a.score));

  return {
    date, category: categoryKey, categoryLabel: category.label, eventLabel: category.eventLabel, meanUnit: category.meanUnit, hasStoredProbAtThreshold: category.hasStoredProbAtThreshold, role: category.role,
    cohortMean, cohortStdev, scoreWeights: ENGINE_BETA_WEIGHTS,
    rows, excludedCategories: EXCLUDED_CATEGORIES,
    games: gamesList.map((g: any) => ({ gameId: g.id, gamePk: Number(g.mlb_game_id), matchup: matchupOf(g.id), firstPitchAt: g.first_pitch_at, gameStatus: g.game_status })),
    teams: (teamsRows ?? []).map((t: any) => ({ abbr: t.abbreviation, name: t.name })),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build the snapshot-row payload for a single game across every category.
 * Returns the insert rows (without snapshot_id) plus a per-category BoardPayload
 * for callers that also want to record data-freshness / cohort stats.
 */
export async function computeGameSnapshotRows(
  admin: any,
  date: string,
  gameId: string,
): Promise<{
  rowsByCategory: Record<EngineBetaCategoryKey, any[]>;
  payloads: Record<EngineBetaCategoryKey, BoardPayload>;
  gameRowCount: number;
}> {
  const rowsByCategory: any = {};
  const payloads: any = {};
  let gameRowCount = 0;
  for (const c of ENGINE_BETA_CATEGORIES) {
    const payload = await computeBoardPayload(admin, date, c.key, { gameIds: [gameId] });
    payloads[c.key] = payload;
    const insertRows = payload.rows.map((r) => ({
      category: c.key,
      role: c.role,
      player_id: r.playerId,
      mlb_id: r.mlbId,
      player_name: r.name,
      team_abbr: r.teamAbbr,
      game_id: r.gameId,
      game_pk: r.gamePk,
      forecast_run_id: r.forecastRunId,
      shadow_run_id: r.shadowRunId,
      lineup_status: r.lineupState,
      batting_order: r.battingOrder,
      baseline: {
        mean: r.baselineMean,
        p50: r.baselineP50,
        p90: r.baselineP90,
        probAtThreshold: r.probAtThreshold,
        eventLabel: r.eventLabel,
        meanUnit: r.meanUnit,
        threshold: c.threshold,
      },
      shadow: r.shadowMean != null ? { mean: r.shadowMean, delta: r.shadowDelta } : null,
      form: {
        applied: r.formApplied,
        reason: r.formReason,
        headlineEvent: r.formHeadlineEvent,
        headlineDelta: r.formHeadlineDelta,
        recentDenominator: r.recentDenominator,
      },
      score: r.score,
      score_components: { ...r.scoreComponents, readiness: r.readiness, readinessReason: r.readinessReason },
      actuals: null,
    }));
    rowsByCategory[c.key] = insertRows;
    gameRowCount += insertRows.length;
  }
  return { rowsByCategory, payloads, gameRowCount };
}
