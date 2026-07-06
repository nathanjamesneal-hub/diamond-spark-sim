/**
 * Diamond Engine Beta — private admin server functions.
 *
 * Reads (never writes) from:
 *   forecast_runs, forecast_player_projections
 *   monte_carlo_form_shadow_runs, monte_carlo_form_shadow_player_outputs
 *   player_recent_event_rates
 *   lineups, starting_pitchers, games, players, teams
 *   projection_results  (post-game actuals)
 *
 * Writes only to:
 *   engine_beta_snapshots, engine_beta_snapshot_rows  (admin-only, private)
 *
 * DOES NOT modify any public forecast, projection, or Diamond Live table.
 * DOES NOT change public model behavior.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ENGINE_BETA_CATEGORIES,
  EXCLUDED_CATEGORIES,
  findCategory,
  type EngineBetaCategoryKey,
} from "./categories";
import { computeEngineBetaScore, ENGINE_BETA_WEIGHTS, type ScoreComponents } from "./score";
import { todayInAppTz } from "@/lib/timezone";

const RECENT_WINDOW_DAYS = 14;

// ---------------- helpers ----------------

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

// Slate date follows the app timezone (America/Chicago), matching the
// convention used by `games.date`, forecast_runs.slate_date, Pulse, and
// the rest of Diamond. Do NOT use UTC — late-evening UTC rolls a day
// early relative to the live MLB slate and would empty the board.


function extractDistEntry(distributions: any, distKey: string): any | null {
  if (!distributions || typeof distributions !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(distributions, distKey)) return distributions[distKey];
  // case-insensitive fallback
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

// ---------------- board ----------------

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
  /** Prob at the category's binary threshold event. null when no matching stored distribution. */
  probAtThreshold: number | null;
  /** Human label for that prob event, e.g. "1+ Hit". Always present. */
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

  lineupState: string;                 // confirmed | projected | missing (hitter) | confirmed | unconfirmed (pitcher)
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

function computeReadiness(role: "hitter" | "pitcher", lineupState: string, forecastGeneratedAt: string | null): { state: ReadinessState; reason: string } {
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
  // pitcher
  if (lineupState === "missing") return { state: "not_ready", reason: "No starter role identified" };
  if (veryStale) return { state: "not_ready", reason: "Forecast >72h old / missing" };
  if (lineupState === "confirmed" || lineupState === "locked") {
    return stale ? { state: "watch", reason: "Confirmed starter, forecast >36h old" } : { state: "ready", reason: "Confirmed starter + fresh forecast" };
  }
  return { state: "watch", reason: "Probable/unconfirmed starter" };
}

const READINESS_RANK: Record<ReadinessState, number> = { ready: 2, watch: 1, not_ready: 0 };

export const getEngineBetaBoard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string; category?: EngineBetaCategoryKey }) => data)
  .handler(async ({ data, context }): Promise<BoardPayload> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;

    const date = data.date ?? todayIsoUtc();
    const catKey: EngineBetaCategoryKey = data.category ?? "H";
    const category = findCategory(catKey);
    if (!category) throw new Error(`Unsupported category ${catKey}`);

    // 1. Slate games
    const { data: games } = await admin
      .from("games")
      .select("id, mlb_game_id, first_pitch_at, game_status, home_team_id, away_team_id")
      .eq("date", date);
    const gamesList = games ?? [];
    if (!gamesList.length) {
      return {
        date, category: catKey, categoryLabel: category.label, eventLabel: category.eventLabel, meanUnit: category.meanUnit, hasStoredProbAtThreshold: category.hasStoredProbAtThreshold, role: category.role,
        cohortMean: null, cohortStdev: null, scoreWeights: ENGINE_BETA_WEIGHTS,
        rows: [], excludedCategories: EXCLUDED_CATEGORIES, games: [], teams: [], generatedAt: new Date().toISOString(),
      };
    }
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

    // 2. Best forecast run per game (locked/published preferred; else latest by generated_at)
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
    if (!runIds.length) {
      return {
        date, category: catKey, categoryLabel: category.label, eventLabel: category.eventLabel, meanUnit: category.meanUnit, hasStoredProbAtThreshold: category.hasStoredProbAtThreshold, role: category.role,
        cohortMean: null, cohortStdev: null, scoreWeights: ENGINE_BETA_WEIGHTS,
        rows: [], excludedCategories: EXCLUDED_CATEGORIES,
        games: gamesList.map((g: any) => ({ gameId: g.id, gamePk: Number(g.mlb_game_id), matchup: matchupOf(g.id), firstPitchAt: g.first_pitch_at, gameStatus: g.game_status })),
        teams: (teamsRows ?? []).map((t: any) => ({ abbr: t.abbreviation, name: t.name })),
        generatedAt: new Date().toISOString(),
      };
    }

    // 3. Player projections for those runs (role-filtered)
    const { data: fpp } = await admin
      .from("forecast_player_projections")
      .select("forecast_run_id, player_id, mlb_id, role, distributions")
      .in("forecast_run_id", runIds)
      .eq("role", category.role);

    // 4. Player+team details
    const playerIds = Array.from(new Set((fpp ?? []).map((r: any) => r.player_id).filter(Boolean)));
    const { data: playerRows } = playerIds.length
      ? await admin.from("players").select("id, name, mlb_id, team_id, teams:team_id(id, name, abbreviation)").in("id", playerIds)
      : { data: [] };
    const playerById = new Map((playerRows ?? []).map((p: any) => [String(p.id), p]));

    // 5. Lineups + starters (opportunity)
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

    // 6. Shadow outputs — latest per (game_id, player, role)
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

    // 7. Recent 14d rates for form denominator
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

    // 8. Build initial rows (baseline + shadow + form + lineup context). Compute cohort after.
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
      if (baselineMean == null) continue; // skip players without persisted baseline for this category

      // Shadow lookup
      const shadowRunId = shadowIdsByGame.get(gid) ?? null;
      const shadowRow = shadowRunId ? shadowByPlayer.get(`${shadowRunId}:${p.player_id}`) : null;
      const shadowEntry = shadowRow ? extractDistEntry(shadowRow.form_distributions, category.distKey) : null;
      const shadowMean = meanFromEntry(shadowEntry);
      const shadowDelta = shadowMean != null && baselineMean != null ? shadowMean - baselineMean : null;

      // Form
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

      // Category-aligned form delta (delta on the SAME event this category tracks)
      let categoryFormDelta: number | null = null;
      const distEventKey = category.distKey; // "H"|"HR"|"K"|"BB"|"TB"|"outs"
      for (const f of fields) {
        if (String(f?.event) === distEventKey && f?.status === "applied") {
          categoryFormDelta = num(f.appliedDelta);
          break;
        }
      }

      // Lineup opportunity
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

    // Cohort stats across all eligible players in category
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

    // Rank inside the same date+category, prioritizing Ready > Watch > Not Ready, then score desc.
    rows.sort((a, b) => (READINESS_RANK[b.readiness] - READINESS_RANK[a.readiness]) || (b.score - a.score));

    return {
      date, category: catKey, categoryLabel: category.label, eventLabel: category.eventLabel, meanUnit: category.meanUnit, hasStoredProbAtThreshold: category.hasStoredProbAtThreshold, role: category.role,
      cohortMean, cohortStdev, scoreWeights: ENGINE_BETA_WEIGHTS,
      rows, excludedCategories: EXCLUDED_CATEGORIES,
      games: gamesList.map((g: any) => ({ gameId: g.id, gamePk: Number(g.mlb_game_id), matchup: matchupOf(g.id), firstPitchAt: g.first_pitch_at, gameStatus: g.game_status })),
      teams: (teamsRows ?? []).map((t: any) => ({ abbr: t.abbreviation, name: t.name })),
      generatedAt: new Date().toISOString(),
    };
  });

// ---------------- lock / snapshot ----------------

export type LockResult = { snapshotId: string; slateDate: string; version: number; rowsWritten: number; categories: EngineBetaCategoryKey[] };

export const lockEngineBetaBoard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string; notes?: string; newVersion?: boolean }) => data)
  .handler(async ({ data, context }): Promise<LockResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;
    const date = data.date ?? todayIsoUtc();

    // Immutability guard: refuse to write a new snapshot for the same slate
    // unless the caller explicitly asks for a new version. Existing snapshots
    // and their rows are never mutated in place.
    const { data: existing } = await admin
      .from("engine_beta_snapshots")
      .select("id, created_at, notes")
      .eq("slate_date", date)
      .order("created_at", { ascending: true });
    const priorCount = (existing ?? []).length;
    if (priorCount > 0 && !data.newVersion) {
      throw new Error(`A locked snapshot already exists for ${date} (v${priorCount}). Prior snapshots are immutable. Pass newVersion=true to record v${priorCount + 1}.`);
    }
    const version = priorCount + 1;

    // Create snapshot header (versioned, immutable)
    const { data: snap, error: snapErr } = await admin
      .from("engine_beta_snapshots")
      .insert({
        slate_date: date,
        created_by: context.userId,
        notes: data.notes ?? null,
        meta: { weights: ENGINE_BETA_WEIGHTS, version, priorSnapshotIds: (existing ?? []).map((s: any) => s.id) },
      })
      .select("id")
      .single();
    if (snapErr) throw new Error(snapErr.message);
    const snapshotId = snap.id as string;

    // Recompute each category board and insert immutable rows
    let rowsWritten = 0;
    const cats: EngineBetaCategoryKey[] = ENGINE_BETA_CATEGORIES.map((c) => c.key);
    for (const cat of cats) {
      const category = findCategory(cat)!;
      // Reuse the getEngineBetaBoard logic by calling it directly
      const board = await (getEngineBetaBoard as any)({ data: { date, category: cat } });
      const insertRows = board.rows.map((r: BoardRow) => ({
        snapshot_id: snapshotId,
        category: cat,
        role: category.role,
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
        baseline: { mean: r.baselineMean, p50: r.baselineP50, p90: r.baselineP90, probAtThreshold: r.probAtThreshold, eventLabel: r.eventLabel, meanUnit: r.meanUnit, threshold: category.threshold },
        shadow: r.shadowMean != null ? { mean: r.shadowMean, delta: r.shadowDelta } : null,
        form: { applied: r.formApplied, reason: r.formReason, headlineEvent: r.formHeadlineEvent, headlineDelta: r.formHeadlineDelta, recentDenominator: r.recentDenominator },
        score: r.score,
        score_components: { ...r.scoreComponents, readiness: r.readiness, readinessReason: r.readinessReason },
        actuals: null,
      }));
      if (insertRows.length) {
        const { error } = await admin.from("engine_beta_snapshot_rows").insert(insertRows);
        if (error) throw new Error(error.message);
        rowsWritten += insertRows.length;
      }
    }

    return { snapshotId, slateDate: date, version, rowsWritten, categories: cats };
  });

// ---------------- grading ----------------

export type GradingRow = {
  category: EngineBetaCategoryKey;
  player: string;
  team: string | null;
  score: number;
  bucket: "80-100" | "60-79" | "0-59";
  baselineMean: number | null;
  shadowMean: number | null;
  actual: number | null;
  hit: boolean | null;
};

export type GradingPayload = {
  snapshotId: string | null;
  slateDate: string;
  createdAt: string | null;
  totalRows: number;
  gradedRows: number;
  byBucket: Record<"80-100" | "60-79" | "0-59", { total: number; graded: number; hits: number; hitRate: number | null }>;
  byCategory: Record<string, { total: number; graded: number; hits: number; hitRate: number | null; baselineMae: number | null; shadowMae: number | null }>;
  incomplete: boolean;
  rows: GradingRow[];
};

export const getEngineBetaGrading = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string; snapshotId?: string }) => data)
  .handler(async ({ data, context }): Promise<GradingPayload> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;
    const date = data.date ?? todayIsoUtc();

    // Pick most recent snapshot for date (or requested id)
    let snap: any = null;
    if (data.snapshotId) {
      const { data: s } = await admin.from("engine_beta_snapshots").select("id, slate_date, created_at").eq("id", data.snapshotId).maybeSingle();
      snap = s;
    } else {
      const { data: s } = await admin.from("engine_beta_snapshots").select("id, slate_date, created_at").eq("slate_date", date).order("created_at", { ascending: false }).limit(1);
      snap = s?.[0] ?? null;
    }
    if (!snap) {
      return { snapshotId: null, slateDate: date, createdAt: null, totalRows: 0, gradedRows: 0, byBucket: emptyBuckets(), byCategory: {}, incomplete: true, rows: [] };
    }
    const { data: rows } = await admin
      .from("engine_beta_snapshot_rows")
      .select("category, role, player_id, player_name, team_abbr, game_id, baseline, shadow, score")
      .eq("snapshot_id", snap.id);
    if (!rows?.length) {
      return { snapshotId: snap.id, slateDate: snap.slate_date, createdAt: snap.created_at, totalRows: 0, gradedRows: 0, byBucket: emptyBuckets(), byCategory: {}, incomplete: true, rows: [] };
    }

    // Load actuals for these players+games
    const gameIds = Array.from(new Set(rows.map((r: any) => r.game_id).filter(Boolean)));
    const playerIds = Array.from(new Set(rows.map((r: any) => r.player_id).filter(Boolean)));
    const { data: gameRows } = gameIds.length
      ? await admin.from("games").select("id, game_status").in("id", gameIds)
      : { data: [] };
    const gameStatus = new Map((gameRows ?? []).map((g: any) => [String(g.id), g.game_status]));
    const { data: actuals } = playerIds.length && gameIds.length
      ? await admin.from("projection_results").select("*").in("player_id", playerIds).in("game_id", gameIds)
      : { data: [] };
    const actualByKey = new Map((actuals ?? []).map((r: any) => [`${r.game_id}:${r.player_id}`, r]));

    const buckets = emptyBuckets();
    const byCat: GradingPayload["byCategory"] = {};
    let incompleteAny = false;
    const grow: GradingRow[] = [];

    for (const r of rows) {
      const category = findCategory(r.category as EngineBetaCategoryKey);
      if (!category) continue;
      const g: any = gameStatus.get(String(r.game_id));
      const gameFinal = typeof g === "string" && /final|game over|completed/i.test(g);
      const a: any = actualByKey.get(`${r.game_id}:${r.player_id}`);
      const actualVal = gameFinal && a ? (a[category.actualsField] as number) : null;
      const bucket: GradingRow["bucket"] = r.score >= 80 ? "80-100" : r.score >= 60 ? "60-79" : "0-59";
      buckets[bucket].total += 1;
      const cat = byCat[r.category] ?? (byCat[r.category] = { total: 0, graded: 0, hits: 0, hitRate: null, baselineMae: null, shadowMae: null });
      cat.total += 1;

      let hit: boolean | null = null;
      if (actualVal != null) {
        const over = actualVal > category.threshold;
        hit = category.higherIsBetter ? over : !over;
        buckets[bucket].graded += 1;
        buckets[bucket].hits += hit ? 1 : 0;
        cat.graded += 1;
        cat.hits += hit ? 1 : 0;
      } else if (!gameFinal) {
        incompleteAny = true;
      }

      grow.push({
        category: r.category,
        player: r.player_name ?? "—",
        team: r.team_abbr ?? null,
        score: Number(r.score),
        bucket,
        baselineMean: num(r.baseline?.mean),
        shadowMean: num(r.shadow?.mean),
        actual: actualVal,
        hit,
      });
    }

    // Rates + MAE
    for (const b of Object.values(buckets)) b.hitRate = b.graded > 0 ? b.hits / b.graded : null;
    for (const catKey of Object.keys(byCat)) {
      const cat = byCat[catKey];
      cat.hitRate = cat.graded > 0 ? cat.hits / cat.graded : null;
      const catRows = grow.filter((r) => r.category === catKey && r.actual != null);
      if (catRows.length) {
        const bMae = catRows.reduce((s, r) => s + (r.baselineMean != null ? Math.abs(r.baselineMean - r.actual!) : 0), 0) / catRows.length;
        const sMae = catRows.filter((r) => r.shadowMean != null).length
          ? catRows.reduce((s, r) => s + (r.shadowMean != null ? Math.abs(r.shadowMean - r.actual!) : 0), 0) / catRows.filter((r) => r.shadowMean != null).length
          : null;
        cat.baselineMae = +bMae.toFixed(3);
        cat.shadowMae = sMae != null ? +sMae.toFixed(3) : null;
      }
    }

    return {
      snapshotId: snap.id,
      slateDate: snap.slate_date,
      createdAt: snap.created_at,
      totalRows: rows.length,
      gradedRows: grow.filter((r) => r.actual != null).length,
      byBucket: buckets,
      byCategory: byCat,
      incomplete: incompleteAny,
      rows: grow,
    };
  });

function emptyBuckets(): GradingPayload["byBucket"] {
  return {
    "80-100": { total: 0, graded: 0, hits: 0, hitRate: null },
    "60-79":  { total: 0, graded: 0, hits: 0, hitRate: null },
    "0-59":   { total: 0, graded: 0, hits: 0, hitRate: null },
  };
}

// ---------------- snapshot list ----------------

export const listEngineBetaSnapshots = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;
    const { data } = await admin
      .from("engine_beta_snapshots")
      .select("id, slate_date, created_at, notes")
      .order("created_at", { ascending: false })
      .limit(25);
    return { snapshots: (data ?? []) as Array<{ id: string; slate_date: string; created_at: string; notes: string | null }> };
  });
