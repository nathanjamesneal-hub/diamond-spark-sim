/**
 * Projection Lab — strictly read-only loaders for persisted Monte Carlo
 * snapshots.
 *
 * Source-of-truth tables (NEVER write, NEVER run a simulator on the read
 * path):
 *   - forecast_runs
 *   - forecast_player_projections
 *   - calibration_summary (for display of persisted calibration metadata)
 *   - model_versions (changelog + active version)
 *
 * If a snapshot did not persist a field (e.g. iterations, calibrated
 * probability, batting order), the loader returns null. The UI renders "—"
 * or "Not stored in snapshot" — it MUST NOT synthesize a value.
 *
 * Visibility rules:
 *   - Public callers: projection_class = 'official' AND status IN
 *     ('published','locked'); superseded rows excluded.
 *   - Admin callers may pass includePreview=true to see preview rows. The
 *     server enforces the admin role check, not the UI.
 *
 * Version partitioning: when more than one run exists for the same slate,
 * we keep the latest non-superseded run per (game_pk, model_version). We
 * do not silently mix Alpha versions in a single row set.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAppMember } from "@/integrations/supabase/member-middleware";
import { todayInAppTz, shiftIsoDate } from "@/lib/timezone";
import { getMarketSimulationMetrics, metricsToSimStat } from "@/lib/forecast/sim-metrics";

const OFFICIAL_RUN_STATUSES = ["published", "locked"] as const;
type OfficialStatus = (typeof OFFICIAL_RUN_STATUSES)[number];

export type GameDisplayState = "scheduled" | "live" | "final";

const TERMINAL_GAME_STATUSES = new Set([
  "Final",
  "Game Over",
  "Completed Early",
  "Postponed",
  "Cancelled",
  "Canceled",
  "Suspended",
]);
const PREGAME_GAME_STATUSES = new Set([
  "Scheduled",
  "Pre-Game",
  "Warmup",
  "Delayed Start: Rain",
  "Delayed Start",
  "Postponed Reschedule",
]);

function classifyGameDisplay(status: string | null | undefined): GameDisplayState {
  const s = String(status ?? "").trim();
  if (!s || PREGAME_GAME_STATUSES.has(s)) return "scheduled";
  if (TERMINAL_GAME_STATUSES.has(s)) return s.startsWith("Final") || s === "Game Over" || s === "Completed Early" ? "final" : "final";
  return "live";
}

async function assertAdminIfPreviewRequested(
  context: { supabase: any; userId: string },
  includePreview: boolean,
) {
  if (!includePreview) return;
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required to view preview snapshots");
}

// -----------------------------------------------------------------------
// Shared joiner
// -----------------------------------------------------------------------

type RunRow = {
  id: string;
  game_pk: number;
  game_id: string;
  slate_date: string;
  model_version: string;
  version_number: number | null;
  status: string;
  projection_class: string;
  trigger_reason: string | null;
  simulation_seed: string | null;
  material_inputs: Record<string, any> | null;
  generated_at: string | null;
  locked_at: string | null;
};

type ProjRow = Record<string, any> & {
  forecast_run_id: string;
  player_id: string;
  mlb_id: number | null;
  role: "hitter" | "pitcher";
};

export type DistStat = {
  mean: number | null;
  p50: number | null;
  p90: number | null;
  stdev: number | null;
  probAtLeast1: number | null;
  probAtLeast2: number | null;
} | null;

export type LabRow = {
  forecast_run_id: string;
  projection_class: string;            // 'official' | 'preview'
  run_status: string;                  // 'published' | 'locked' | 'superseded'
  forecast_timestamp: string | null;   // locked_at ?? generated_at
  model_version: string;
  version_number: number | null;
  simulation_seed: string | null;
  iterations_persisted: number | null;

  game_pk: number;
  game_id: string;
  game_date: string | null;
  game_status_raw: string | null;
  game_display: GameDisplayState;

  home_team: { id: string; abbr: string; name: string } | null;
  away_team: { id: string; abbr: string; name: string } | null;
  player_team_abbr: string | null;
  opponent_abbr: string | null;

  player: {
    id: string;
    mlb_id: number | null;
    full_name: string | null;
    position: string | null;
  } | null;
  role: "hitter" | "pitcher";
  batting_order: number | null;
  batting_order_source: "snapshot" | "lineups" | null;

  // Persisted Alpha layer
  diamond_score: number | null;
  confidence: number | null;
  hit_probability: number | null;
  total_base_probability: number | null;
  hr_probability: number | null;
  rbi_probability: number | null;
  run_probability: number | null;
  sb_probability: number | null;
  pitcher_win_probability: number | null;
  quality_start_probability: number | null;
  projected_outs: number | null;

  // Persisted calibration (currently never stored — always null until a
  // future writer adds it). Lab UI renders "Raw · uncalibrated" when null.
  calibrated_hit_probability: number | null;
  calibration_version: string | null;

  // Persisted Monte Carlo distributions (hitter or pitcher keys)
  distributions: {
    H: DistStat;
    HR: DistStat;
    TB: DistStat;
    RBI: DistStat;
    R: DistStat;
    K: DistStat;
    BB: DistStat;
    outs: DistStat;
    ER: DistStat;
  };

  actual: Record<string, any> | null;
};

export type LabPayload = {
  date: string;
  reason: "explicit" | "latest_official" | "no_official_anywhere";
  runs: Array<{
    id: string;
    game_pk: number;
    model_version: string;
    version_number: number | null;
    status: string;
    projection_class: string;
    generated_at: string | null;
    locked_at: string | null;
  }>;
  rows: LabRow[];
  model_versions_present: string[];
  missing_distribution_count: number;
};

async function pickDefaultDate(
  supabase: any,
  explicit: string | undefined,
  includePreview: boolean,
): Promise<{ date: string; reason: LabPayload["reason"] }> {
  if (explicit) return { date: explicit, reason: "explicit" };
  // Latest Chicago-date slate with at least one OFFICIAL run. Never silently
  // pick a preview-only date even when admin includePreview is true — that
  // toggle is for overlay, not for default routing.
  const { data } = await supabase
    .from("forecast_runs")
    .select("slate_date")
    .eq("projection_class", "official")
    .in("status", OFFICIAL_RUN_STATUSES as unknown as string[])
    .is("superseded_by", null)
    .lte("slate_date", todayInAppTz())
    .order("slate_date", { ascending: false })
    .limit(1);
  const latest = data?.[0]?.slate_date;
  if (latest) return { date: String(latest), reason: "latest_official" };
  // Tier 3: no official runs exist anywhere. Anchor to today Chicago and
  // let the UI render the explicit empty state.
  void includePreview;
  return { date: todayInAppTz(), reason: "no_official_anywhere" };
}

async function loadLab(
  context: { supabase: any; userId: string },
  args: {
    date?: string;
    gamePk?: number;
    role?: "hitter" | "pitcher";
    team?: string;
    includePreview?: boolean;
    modelVersion?: string;
  },
): Promise<LabPayload> {
  const { supabase } = context;
  const includePreview = !!args.includePreview;
  await assertAdminIfPreviewRequested(context, includePreview);

  const { date, reason } = await pickDefaultDate(supabase, args.date, includePreview);

  // 1) Select forecast_runs for the slate.
  let runsQ = supabase
    .from("forecast_runs")
    .select(
      "id, game_pk, game_id, slate_date, model_version, version_number, status, projection_class, trigger_reason, simulation_seed, material_inputs, generated_at, locked_at",
    )
    .eq("slate_date", date)
    .is("superseded_by", null)
    .in("status", OFFICIAL_RUN_STATUSES as unknown as string[]);
  if (includePreview) {
    runsQ = runsQ.in("projection_class", ["official", "preview"]);
  } else {
    runsQ = runsQ.eq("projection_class", "official");
  }
  if (args.gamePk) runsQ = runsQ.eq("game_pk", args.gamePk);
  if (args.modelVersion) runsQ = runsQ.eq("model_version", args.modelVersion);
  const { data: runsRaw, error: runsErr } = await runsQ;
  if (runsErr) throw new Error(runsErr.message);
  const runs = (runsRaw ?? []) as RunRow[];

  // 2) Partition by (game_pk, model_version, projection_class) — keep latest
  //    version_number per partition. We DO NOT collapse across model_version
  //    because that would silently mix Alpha 0.3 and Alpha 0.4 numbers.
  const partitionKey = (r: RunRow) =>
    `${r.game_pk}::${r.model_version}::${r.projection_class}`;
  const bestByKey = new Map<string, RunRow>();
  for (const r of runs) {
    const k = partitionKey(r);
    const cur = bestByKey.get(k);
    if (!cur || (r.version_number ?? 0) > (cur.version_number ?? 0)) bestByKey.set(k, r);
  }
  const selectedRuns = Array.from(bestByKey.values());

  if (selectedRuns.length === 0) {
    return {
      date,
      reason,
      runs: [],
      rows: [],
      model_versions_present: [],
      missing_distribution_count: 0,
    };
  }

  // 3) Fetch projections for those runs.
  const runIds = selectedRuns.map((r) => r.id);
  let pq = supabase
    .from("forecast_player_projections")
    .select("*")
    .in("forecast_run_id", runIds);
  if (args.role) pq = pq.eq("role", args.role);
  const { data: projsRaw, error: pErr } = await pq;
  if (pErr) throw new Error(pErr.message);
  const projs = (projsRaw ?? []) as ProjRow[];

  // 4) Joins for display only.
  const gameIds = Array.from(new Set(selectedRuns.map((r) => r.game_id))).filter(Boolean);
  const { data: gamesData } = gameIds.length
    ? await supabase
        .from("games")
        .select(
          "id, mlb_game_id, date, game_status, first_pitch_at, home_team_id, away_team_id",
        )
        .in("id", gameIds)
    : { data: [] as any[] };
  const gamesById = new Map((gamesData ?? []).map((g: any) => [g.id, g]));

  const playerIds = Array.from(
    new Set(projs.map((p) => p.player_id).filter(Boolean)),
  );
  const { data: playersData } = playerIds.length
    ? await supabase
        .from("players")
        .select("id, mlb_id, full_name, position, team_id")
        .in("id", playerIds)
    : { data: [] as any[] };
  const playersById = new Map((playersData ?? []).map((p: any) => [p.id, p]));

  const teamIds = Array.from(
    new Set(
      [
        ...(gamesData ?? []).flatMap((g: any) => [g.home_team_id, g.away_team_id]),
        ...(playersData ?? []).map((p: any) => p.team_id),
      ].filter(Boolean),
    ),
  );
  const { data: teamsData } = teamIds.length
    ? await supabase
        .from("teams")
        .select("id, abbreviation, name")
        .in("id", teamIds)
    : { data: [] as any[] };
  const teamsById = new Map((teamsData ?? []).map((t: any) => [t.id, t]));

  // Lineups fallback (display only — material_inputs wins when present).
  const { data: lineupsData } = gameIds.length
    ? await supabase
        .from("lineups")
        .select("game_id, player_id, batting_order, team_id")
        .in("game_id", gameIds)
    : { data: [] as any[] };
  const lineupKey = (gid: string, pid: string) => `${gid}::${pid}`;
  const lineupsByKey = new Map(
    (lineupsData ?? []).map((l: any) => [lineupKey(l.game_id, l.player_id), l]),
  );

  // Final-game actuals.
  const { data: actualsData } = gameIds.length
    ? await supabase
        .from("projection_results")
        .select("*")
        .in("game_id", gameIds)
    : { data: [] as any[] };
  const actualsByKey = new Map(
    (actualsData ?? []).map((a: any) => [`${a.game_id}::${a.player_id}`, a]),
  );

  const runsByRunId = new Map(selectedRuns.map((r) => [r.id, r]));

  function readBattingOrderFromSnapshot(
    mi: Record<string, any> | null,
    mlbId: number | null,
  ): number | null {
    if (!mi || mlbId == null) return null;
    const home = Array.isArray(mi.homeLineup) ? mi.homeLineup : [];
    const away = Array.isArray(mi.awayLineup) ? mi.awayLineup : [];
    const inHome = home.find((x: any) => Number(x?.mlbId) === mlbId);
    if (inHome?.order != null) return Number(inHome.order);
    const inAway = away.find((x: any) => Number(x?.mlbId) === mlbId);
    if (inAway?.order != null) return Number(inAway.order);
    return null;
  }

  function pickIterations(mi: Record<string, any> | null): number | null {
    if (!mi) return null;
    if (typeof mi.iterations === "number" && isFinite(mi.iterations)) return mi.iterations;
    // Some writers tuck it under nested keys; never assume.
    return null;
  }

  let missingDist = 0;
  const rows: LabRow[] = [];
  for (const p of projs) {
    const run = runsByRunId.get(p.forecast_run_id);
    if (!run) continue;
    const game: any = gamesById.get(run.game_id);
    const player: any = playersById.get(p.player_id);
    const homeTeam: any = game ? teamsById.get(game.home_team_id) : null;
    const awayTeam: any = game ? teamsById.get(game.away_team_id) : null;
    const playerTeam: any = player ? teamsById.get(player.team_id) : null;
    const opp: any = playerTeam && game
      ? (playerTeam.id === game.home_team_id ? awayTeam : playerTeam.id === game.away_team_id ? homeTeam : null)
      : null;

    let battingOrder: number | null = null;
    let battingOrderSource: "snapshot" | "lineups" | null = null;
    const snapOrder = readBattingOrderFromSnapshot(run.material_inputs, player?.mlb_id ?? null);
    if (snapOrder != null) {
      battingOrder = snapOrder;
      battingOrderSource = "snapshot";
    } else if (game) {
      const l: any = lineupsByKey.get(lineupKey(game.id, p.player_id));
      if (l?.batting_order != null) {
        battingOrder = l.batting_order;
        battingOrderSource = "lineups";
      }
    }

    const selectedForecast = {
      forecastRunId: p.forecast_run_id,
      projectionClass: run.projection_class,
      fppDistributions: p.distributions ?? null,
      projectionSimSnapshot: null,
    };
    if (!p.distributions) missingDist += 1;
    const ds = (market: Parameters<typeof getMarketSimulationMetrics>[0]["market"]): DistStat => metricsToSimStat(getMarketSimulationMetrics({
      selectedForecast,
      role: p.role,
      market,
    })) as DistStat;

    const actual = game ? (actualsByKey.get(`${game.id}::${p.player_id}`) ?? null) : null;

    const row: LabRow = {
      forecast_run_id: p.forecast_run_id,
      projection_class: run.projection_class,
      run_status: run.status,
      forecast_timestamp: run.locked_at ?? run.generated_at,
      model_version: run.model_version,
      version_number: run.version_number,
      simulation_seed: run.simulation_seed,
      iterations_persisted: pickIterations(run.material_inputs),
      game_pk: run.game_pk,
      game_id: run.game_id,
      game_date: game?.date ?? null,
      game_status_raw: game?.game_status ?? null,
      game_display: classifyGameDisplay(game?.game_status),
      home_team: homeTeam ? { id: homeTeam.id, abbr: homeTeam.abbreviation, name: homeTeam.name } : null,
      away_team: awayTeam ? { id: awayTeam.id, abbr: awayTeam.abbreviation, name: awayTeam.name } : null,
      player_team_abbr: playerTeam?.abbreviation ?? null,
      opponent_abbr: opp?.abbreviation ?? null,
      player: player
        ? {
            id: player.id,
            mlb_id: player.mlb_id ?? null,
            full_name: player.full_name ?? null,
            position: player.position ?? null,
          }
        : null,
      role: p.role,
      batting_order: battingOrder,
      batting_order_source: battingOrderSource,

      diamond_score: p.diamond_score ?? null,
      confidence: p.confidence ?? null,
      hit_probability: p.hit_probability ?? null,
      total_base_probability: p.total_base_probability ?? null,
      hr_probability: p.hr_probability ?? null,
      rbi_probability: p.rbi_probability ?? null,
      run_probability: p.run_probability ?? null,
      sb_probability: p.sb_probability ?? null,
      pitcher_win_probability: p.pitcher_win_probability ?? null,
      quality_start_probability: p.quality_start_probability ?? null,
      projected_outs: p.projected_outs ?? null,

      // No writer currently persists calibrated hit probability or
      // calibration version into forecast_player_projections — surface as
      // null so the UI shows "Raw · uncalibrated". Never compute on read.
      calibrated_hit_probability:
        typeof (p as any).calibrated_hit_probability === "number"
          ? (p as any).calibrated_hit_probability
          : null,
      calibration_version:
        typeof (p as any).calibration_version === "string"
          ? (p as any).calibration_version
          : null,

      distributions: {
        H: ds("H"),
        HR: ds("HR"),
        TB: ds("TB"),
        RBI: ds("RBI"),
        R: ds("R"),
        K: ds("K"),
        BB: ds("BB"),
        outs: ds("OUTS"),
        ER: ds("ER"),
      },
      actual,
    };

    if (args.team && row.player_team_abbr !== args.team) continue;
    rows.push(row);
  }

  const versionsPresent = Array.from(new Set(selectedRuns.map((r) => r.model_version))).sort();

  return {
    date,
    reason,
    runs: selectedRuns.map((r) => ({
      id: r.id,
      game_pk: r.game_pk,
      model_version: r.model_version,
      version_number: r.version_number,
      status: r.status,
      projection_class: r.projection_class,
      generated_at: r.generated_at,
      locked_at: r.locked_at,
    })),
    rows,
    model_versions_present: versionsPresent,
    missing_distribution_count: missingDist,
  };
}

// -----------------------------------------------------------------------
// Server functions
// -----------------------------------------------------------------------

export const getProjectionLabMeans = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator(
    (data:
      | {
          date?: string;
          gamePk?: number;
          role?: "hitter" | "pitcher";
          team?: string;
          includePreview?: boolean;
          modelVersion?: string;
        }
      | undefined) => ({
      date: data?.date,
      gamePk: data?.gamePk,
      role: data?.role,
      team: data?.team,
      includePreview: !!data?.includePreview,
      modelVersion: data?.modelVersion,
    }),
  )
  .handler(async ({ data, context }) => loadLab(context, data));

export const getProjectionLabAlphaCompare = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator(
    (data:
      | { date?: string; includePreview?: boolean; modelVersion?: string }
      | undefined) => ({
      date: data?.date,
      includePreview: !!data?.includePreview,
      modelVersion: data?.modelVersion,
    }),
  )
  .handler(async ({ data, context }) => loadLab(context, { ...data, role: "hitter" }));

// -----------------------------------------------------------------------
// Engine status
// -----------------------------------------------------------------------

export type EngineStatusPayload = {
  today: string;
  active_versions: string[];
  drifted: boolean;
  recent_usage: Array<{ model_version: string; count: number; first: string; last: string }>;
  shadow_candidates: Array<{ version: string; runs: number; first: string; last: string }>;
  calibration: {
    last_computed_at: string | null;
    model_versions: string[];
  };
  iterations_observed: {
    latest_value: number | null;
    persisted_count: number;
    missing_count: number;
  };
  today_lifecycle: {
    by_status: Array<{ status: string; count: number }>;
    by_class: Array<{ projection_class: string; count: number }>;
    has_official_today: boolean;
  };
  latest_official_publication_at: string | null;
  model_versions: Array<{
    version: string;
    active: boolean;
    release_date: string | null;
    notes: string | null;
  }>;
};

export const getEngineStatus = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .handler(async ({ context }): Promise<EngineStatusPayload> => {
    const { supabase } = context;
    const today = todayInAppTz();
    const sevenAgo = shiftIsoDate(today, -7);

    const [{ data: mvAll }, { data: calRows }, { data: recentRuns }, { data: todayRuns }, { data: latestPub }] =
      await Promise.all([
        supabase
          .from("model_versions")
          .select("version, active, release_date, notes")
          .order("release_date", { ascending: false }),
        supabase
          .from("calibration_summary")
          .select("model_version, computed_at")
          .order("computed_at", { ascending: false })
          .limit(500),
        supabase
          .from("forecast_runs")
          .select("model_version, slate_date, projection_class, status, material_inputs, generated_at, locked_at")
          .gte("slate_date", sevenAgo)
          .lte("slate_date", today)
          .eq("projection_class", "official")
          .in("status", OFFICIAL_RUN_STATUSES as unknown as string[])
          .is("superseded_by", null),
        supabase
          .from("forecast_runs")
          .select("status, projection_class")
          .eq("slate_date", today)
          .is("superseded_by", null),
        supabase
          .from("forecast_runs")
          .select("locked_at, generated_at")
          .eq("projection_class", "official")
          .in("status", OFFICIAL_RUN_STATUSES as unknown as string[])
          .is("superseded_by", null)
          .order("locked_at", { ascending: false, nullsFirst: false })
          .limit(1),
      ]);

    const modelVersions = (mvAll ?? []).map((m: any) => ({
      version: String(m.version),
      active: !!m.active,
      release_date: m.release_date ? String(m.release_date) : null,
      notes: m.notes ?? null,
    }));
    const activeVersions = modelVersions.filter((m) => m.active).map((m) => m.version);

    // Usage of versions in the last 7 days.
    const usageMap = new Map<string, { count: number; first: string; last: string }>();
    let iterLatest: number | null = null;
    let iterLatestAt = "";
    let iterCount = 0;
    let iterMissing = 0;
    for (const r of recentRuns ?? []) {
      const v = String(r.model_version);
      const ts = String(r.locked_at ?? r.generated_at ?? "");
      const cur = usageMap.get(v);
      if (!cur) usageMap.set(v, { count: 1, first: ts, last: ts });
      else {
        cur.count += 1;
        if (ts && ts < cur.first) cur.first = ts;
        if (ts && ts > cur.last) cur.last = ts;
      }
      const mi = (r as any).material_inputs;
      const it = mi && typeof mi.iterations === "number" ? mi.iterations : null;
      if (it != null) {
        iterCount += 1;
        if (ts > iterLatestAt) {
          iterLatest = it;
          iterLatestAt = ts;
        }
      } else {
        iterMissing += 1;
      }
    }
    const recent_usage = Array.from(usageMap.entries())
      .map(([model_version, v]) => ({ model_version, count: v.count, first: v.first, last: v.last }))
      .sort((a, b) => b.count - a.count);

    // Shadow candidates: versions in forecast_runs that aren't active.
    const shadow_candidates: EngineStatusPayload["shadow_candidates"] = [];
    for (const u of recent_usage) {
      if (!activeVersions.includes(u.model_version)) {
        shadow_candidates.push({
          version: u.model_version,
          runs: u.count,
          first: u.first,
          last: u.last,
        });
      }
    }

    // Today lifecycle counts.
    const byStatus = new Map<string, number>();
    const byClass = new Map<string, number>();
    let hasOfficialToday = false;
    for (const r of todayRuns ?? []) {
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      byClass.set(r.projection_class, (byClass.get(r.projection_class) ?? 0) + 1);
      if (
        r.projection_class === "official" &&
        (r.status === "published" || r.status === "locked")
      ) {
        hasOfficialToday = true;
      }
    }

    // Calibration summary timestamps.
    let calLast: string | null = null;
    const calVersions = new Set<string>();
    for (const c of calRows ?? []) {
      const t = c.computed_at as string;
      if (!calLast || t > calLast) calLast = t;
      if (c.model_version) calVersions.add(String(c.model_version));
    }

    const latestPubRow = (latestPub ?? [])[0] as any;
    const latest_official_publication_at = latestPubRow
      ? String(latestPubRow.locked_at ?? latestPubRow.generated_at ?? "") || null
      : null;

    return {
      today,
      active_versions: activeVersions,
      drifted: activeVersions.length === 0
        ? false
        : recent_usage.length > 0 && !activeVersions.includes(recent_usage[0].model_version),
      recent_usage,
      shadow_candidates,
      calibration: {
        last_computed_at: calLast,
        model_versions: Array.from(calVersions).sort(),
      },
      iterations_observed: {
        latest_value: iterLatest,
        persisted_count: iterCount,
        missing_count: iterMissing,
      },
      today_lifecycle: {
        by_status: Array.from(byStatus.entries()).map(([status, count]) => ({ status, count })),
        by_class: Array.from(byClass.entries()).map(([projection_class, count]) => ({ projection_class, count })),
        has_official_today: hasOfficialToday,
      },
      latest_official_publication_at,
      model_versions: modelVersions,
    };
  });
