import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const HITTER_EVENTS = ["H", "HR", "K", "BB", "TB", "R", "RBI"] as const;
const PITCHER_EVENTS = ["outs", "K", "BB", "H", "ER"] as const;

export type DistroSummary = {
  mean: number | null;
  p50: number | null;
  p90: number | null;
  probAtLeast1?: number | null;
  probAtLeast2?: number | null;
};

export type ShadowPlayerRow = {
  playerId: string;
  mlbId: number | null;
  name: string;
  team: string | null;
  teamAbbr: string | null;
  role: "hitter" | "pitcher";
  applied: boolean;
  reason: string;
  headlineEvent: string | null;
  headlineDelta: number | null;
  recentDenominator: number | null;
  seasonDenominator: number | null;
  events: Array<{
    event: string;
    baselineMean: number | null;
    formMean: number | null;
    delta: number | null;
  }>;
  eventKind: "hitter" | "pitcher";
  baselineDistributions: any;
  formDistributions: any;
  formAdjustments: any;
  actuals: any;
};

export type ShadowRunSummary = {
  runId: string;
  createdAt: string;
  slateDate: string;
  gamePk: number;
  gameId: string;
  matchup: string;
  homeTeam: string | null;
  awayTeam: string | null;
  seed: number;
  iterations: number;
  formWindowDays: number;
  modelVersion: string;
  baselineForecastRunId: string;
};

export type ShadowRunListEntry = {
  runId: string;
  createdAt: string;
  slateDate: string;
  gamePk: number;
  matchup: string;
  applied: number;
  totalPlayers: number;
};

export type ShadowDiagnosticsPayload = {
  totals: {
    shadowRuns: number;
    playerOutputs: number;
    latestSlateDate: string | null;
    rawEventsSource: string | null;
    rawEventsFetchedAt: string | null;
    rawEventsAsOfDate: string | null;
    rawEventsFinalGames: number | null;
  };
  runs: ShadowRunListEntry[];
  latest: {
    run: ShadowRunSummary | null;
    players: ShadowPlayerRow[];
    applied: number;
    insufficient: number;
    withActuals: number;
  };
};

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

function num(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function eventList(role: "hitter" | "pitcher"): readonly string[] {
  return role === "hitter" ? HITTER_EVENTS : PITCHER_EVENTS;
}

function headlineFromAdjustments(adj: any): { headlineEvent: string | null; headlineDelta: number | null; applied: boolean; reason: string; recentDenominator: number | null; seasonDenominator: number | null } {
  const applied = !!adj?.applied;
  const recentDenominator = num(adj?.recentDenominator);
  const seasonDenominator = num(adj?.seasonDenominator);
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
  let reason: string;
  if (!applied) {
    reason = adj?.reason ? String(adj.reason) : "No adjustment — insufficient recent sample";
  } else if (headlineEvent && headlineDelta != null) {
    const dir = headlineDelta > 0 ? "higher" : "lower";
    reason = `Recent ${headlineEvent} rate ${dir} than season baseline; shrunk adjustment applied`;
  } else {
    reason = "Recent form within event caps; minimal adjustment applied";
  }
  return { headlineEvent, headlineDelta, applied, reason, recentDenominator, seasonDenominator };
}

async function loadRunSummary(admin: any, runId: string): Promise<ShadowRunSummary | null> {
  const { data: run, error: runErr } = await admin
    .from("monte_carlo_form_shadow_runs")
    .select("id, created_at, slate_date, game_id, game_pk, seed, iterations, form_window_days, model_version, baseline_forecast_run_id")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) throw new Error(runErr.message);
  if (!run) return null;

  const { data: game } = await admin
    .from("games")
    .select("id, home_team_id, away_team_id, teams_home:teams!games_home_team_id_fkey(id, name, abbreviation), teams_away:teams!games_away_team_id_fkey(id, name, abbreviation)")
    .eq("id", run.game_id)
    .maybeSingle();

  const home = game?.teams_home?.abbreviation ?? game?.teams_home?.name ?? null;
  const away = game?.teams_away?.abbreviation ?? game?.teams_away?.name ?? null;
  const matchup = home && away ? `${away} @ ${home}` : `MLB ${run.game_pk}`;

  return {
    runId: run.id,
    createdAt: String(run.created_at),
    slateDate: String(run.slate_date),
    gamePk: Number(run.game_pk),
    gameId: String(run.game_id),
    matchup,
    homeTeam: home,
    awayTeam: away,
    seed: Number(run.seed),
    iterations: Number(run.iterations),
    formWindowDays: Number(run.form_window_days),
    modelVersion: String(run.model_version),
    baselineForecastRunId: String(run.baseline_forecast_run_id),
  };
}

async function loadPlayersForRun(admin: any, runId: string): Promise<ShadowPlayerRow[]> {
  const { data: outputs, error: outErr } = await admin
    .from("monte_carlo_form_shadow_player_outputs")
    .select("shadow_run_id, player_id, mlb_id, role, baseline_distributions, form_distributions, form_adjustments, actuals")
    .eq("shadow_run_id", runId);
  if (outErr) throw new Error(outErr.message);
  if (!outputs?.length) return [];

  const playerIds = Array.from(new Set(outputs.map((r: any) => r.player_id).filter(Boolean)));
  const { data: players } = playerIds.length
    ? await admin
        .from("players")
        .select("id, full_name, team_id, teams:team_id(id, name, abbreviation)")
        .in("id", playerIds)
    : { data: [] };
  const playerById = new Map<string, any>((players ?? []).map((p: any) => [String(p.id), p]));

  return (outputs as any[]).map((row) => {
    const role = (row.role as "hitter" | "pitcher") ?? "hitter";
    const player = playerById.get(String(row.player_id));
    const name = player?.full_name ?? `MLB ${row.mlb_id ?? "?"}`;
    const team = player?.teams?.name ?? null;
    const teamAbbr = player?.teams?.abbreviation ?? null;

    const events = eventList(role).map((event) => {
      const b = row.baseline_distributions?.[event];
      const f = row.form_distributions?.[event];
      const bm = num(b?.mean);
      const fm = num(f?.mean);
      return {
        event,
        baselineMean: bm,
        formMean: fm,
        delta: bm != null && fm != null ? fm - bm : null,
      };
    });

    const head = headlineFromAdjustments(row.form_adjustments);

    return {
      playerId: String(row.player_id),
      mlbId: row.mlb_id != null ? Number(row.mlb_id) : null,
      name,
      team,
      teamAbbr,
      role,
      applied: head.applied,
      reason: head.reason,
      headlineEvent: head.headlineEvent,
      headlineDelta: head.headlineDelta,
      recentDenominator: head.recentDenominator,
      seasonDenominator: head.seasonDenominator,
      events,
      eventKind: role,
      baselineDistributions: row.baseline_distributions ?? null,
      formDistributions: row.form_distributions ?? null,
      formAdjustments: row.form_adjustments ?? null,
      actuals: row.actuals ?? null,
    };
  });
}

export const getFormShadowDiagnostics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { runId?: string } | undefined) => data ?? {})
  .handler(async ({ data, context }): Promise<ShadowDiagnosticsPayload> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;

    const [{ count: runCount }, { count: outputCount }] = await Promise.all([
      admin.from("monte_carlo_form_shadow_runs").select("id", { count: "exact", head: true }),
      admin.from("monte_carlo_form_shadow_player_outputs").select("shadow_run_id", { count: "exact", head: true }),
    ]);

    const { data: runsRaw } = await admin
      .from("monte_carlo_form_shadow_runs")
      .select("id, created_at, slate_date, game_pk")
      .order("created_at", { ascending: false })
      .limit(50);

    const runs: ShadowRunListEntry[] = [];
    for (const r of runsRaw ?? []) {
      const { data: outs } = await admin
        .from("monte_carlo_form_shadow_player_outputs")
        .select("form_adjustments")
        .eq("shadow_run_id", r.id);
      const total = outs?.length ?? 0;
      const applied = (outs ?? []).filter((o: any) => !!o?.form_adjustments?.applied).length;
      runs.push({
        runId: String(r.id),
        createdAt: String(r.created_at),
        slateDate: String(r.slate_date),
        gamePk: Number(r.game_pk),
        matchup: `MLB ${r.game_pk}`,
        applied,
        totalPlayers: total,
      });
    }

    const targetRunId = data.runId ?? runs[0]?.runId ?? null;
    let latestRun: ShadowRunSummary | null = null;
    let latestPlayers: ShadowPlayerRow[] = [];
    if (targetRunId) {
      latestRun = await loadRunSummary(admin, targetRunId);
      latestPlayers = await loadPlayersForRun(admin, targetRunId);
    }

    if (latestRun) {
      const summary = latestRun;
      const match = runs.find((r) => r.runId === summary.runId);
      if (match) match.matchup = summary.matchup;
    }

    const applied = latestPlayers.filter((p) => p.applied).length;
    const insufficient = latestPlayers.length - applied;
    const withActuals = latestPlayers.filter((p) => p.actuals && Object.keys(p.actuals).length > 0).length;

    let rawEventsSource: string | null = null;
    let rawEventsFetchedAt: string | null = null;
    let rawEventsAsOfDate: string | null = null;
    let rawEventsFinalGames: number | null = null;
    if (latestRun) {
      const { data: rateRow } = await admin
        .from("player_recent_event_rates")
        .select("source, source_fetched_at, as_of_date")
        .eq("as_of_date", latestRun.slateDate)
        .eq("window_days", latestRun.formWindowDays)
        .order("source_fetched_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      rawEventsSource = rateRow?.source ?? null;
      rawEventsFetchedAt = rateRow?.source_fetched_at ?? null;
      rawEventsAsOfDate = rateRow?.as_of_date ?? null;
      const { count: gameCount } = await admin
        .from("player_recent_game_event_counts")
        .select("game_pk", { count: "exact", head: true })
        .gte("game_date", latestRun ? new Date(new Date(latestRun.slateDate).getTime() - (latestRun.formWindowDays - 1) * 86400000).toISOString().slice(0, 10) : "1900-01-01")
        .lte("game_date", latestRun?.slateDate ?? "9999-12-31");
      rawEventsFinalGames = gameCount ?? null;
    }

    return {
      totals: {
        shadowRuns: runCount ?? 0,
        playerOutputs: outputCount ?? 0,
        latestSlateDate: latestRun?.slateDate ?? null,
        rawEventsSource,
        rawEventsFetchedAt,
        rawEventsAsOfDate,
        rawEventsFinalGames,
      },
      runs,
      latest: {
        run: latestRun,
        players: latestPlayers,
        applied,
        insufficient,
        withActuals,
      },
    };
  });
