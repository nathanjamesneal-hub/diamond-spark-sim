/**
 * Diamond Research Leaders — private admin research board.
 *
 * Ranks the top 25 model-favored player-days WITHIN each exact stat category,
 * using only persisted `sim_player_outputs` for the selected slate date.
 *
 * This is NOT a sportsbook. No lines, prices, edges, picks, or recommendations
 * are computed or returned.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

export type ResearchCategoryKey =
  | "HIT_1_PLUS"
  | "HIT_2_PLUS"
  | "TOTAL_BASES_2_PLUS"
  | "HOME_RUN"
  | "RBI_1_PLUS"
  | "RUN_1_PLUS"
  | "PITCHER_STRIKEOUTS";

export type ResearchCategoryDef = {
  key: ResearchCategoryKey;
  label: string;
  eventLabel: string;
  market: string; // sim_player_outputs.market
  playerType: "bat" | "pit";
  meanLabel: string;
};

export const RESEARCH_CATEGORIES: ResearchCategoryDef[] = [
  { key: "HIT_1_PLUS",        label: "1+ Hit",           eventLabel: "1+ Hit",              market: "1plus_hit",   playerType: "bat", meanLabel: "Proj Hits" },
  { key: "HIT_2_PLUS",        label: "2+ Hits",          eventLabel: "2+ Hits",             market: "2plus_hits",  playerType: "bat", meanLabel: "Proj Hits" },
  { key: "TOTAL_BASES_2_PLUS",label: "2+ Total Bases",   eventLabel: "2+ Total Bases",      market: "total_bases", playerType: "bat", meanLabel: "Proj TB" },
  { key: "HOME_RUN",          label: "Home Run",         eventLabel: "1+ HR",               market: "hr",          playerType: "bat", meanLabel: "Proj HR" },
  { key: "RBI_1_PLUS",        label: "1+ RBI",           eventLabel: "1+ RBI",              market: "1plus_rbi",   playerType: "bat", meanLabel: "Proj RBI" },
  { key: "RUN_1_PLUS",        label: "1+ Run",           eventLabel: "1+ Run",              market: "1plus_run",   playerType: "bat", meanLabel: "Proj R" },
  { key: "PITCHER_STRIKEOUTS",label: "Pitcher Ks",       eventLabel: "Pitcher Strikeouts",  market: "k",           playerType: "pit", meanLabel: "Proj K" },
];

export type ResearchConfidenceTier =
  | "HEAVY_CONFIDENCE"
  | "STRONG_RESEARCH"
  | "WATCHLIST"
  | "BETA_UNVALIDATED";

export type ResearchDataStatus =
  | "CONFIRMED_INPUTS"
  | "FORECAST_FRESH"
  | "SIM_COMPLETE"
  | "WAITING_ON_LINEUP"
  | "STARTER_UNCONFIRMED"
  | "STALE"
  | "NOT_LOCK_ELIGIBLE";

export type ResearchLeaderRow = {
  rank: number;
  category: ResearchCategoryKey;
  playerId: string;
  playerName: string;
  mlbId: number | null;
  playerType: "bat" | "pit";
  teamAbbrev: string | null;
  oppAbbrev: string | null;
  gameId: string;
  gamePk: number;
  firstPitchAt: string | null;
  eventLabel: string;
  eventProbability: number;
  projectedMean: number;
  threshold: number | null;
  projectedPA: number | null;
  projectedBF: number | null;
  battingOrder: number | null;
  stderr: number | null;
  confidence: number;
  engineStatus: "scaffold_unvalidated" | "validated";
  runStatus: string;
  simTier: string;
  simCount: number;
  iterations: number | null;
  iterationsSource: "output.sim_count" | "output.driver_metadata.iterations" | "job.sim_count" | null;
  iterationsLabel: string; // "Simulation: 20,000 runs" or "Simulation count unavailable"
  simJobId: string;
  jobStatus: string;
  inputsHash: string;
  completedAt: string;
  lineupConfirmed: boolean;
  starterConfirmed: boolean;
  opposingStarterConfirmed: boolean;
  forecastFresh: boolean;
  lockEligible: boolean;
  dataStatuses: ResearchDataStatus[];
  confidenceTier: ResearchConfidenceTier;
  confidenceReasons: string[];
  inputsStrong: boolean; // for BETA_UNVALIDATED subtitle
  researchSignal: number; // 0..100
  whyItSurfaced: string;
};

export type ResearchCategorySection = {
  category: ResearchCategoryDef;
  rows: ResearchLeaderRow[];
  totalCandidates: number;
};

export type ResearchLeadersPayload = {
  slateDate: string;
  generatedAt: string;
  categories: ResearchCategorySection[];
  filters: {
    eligibleOnly: boolean;
    includeWaiting: boolean;
  };
};

function percentileRank(values: number[]): Map<number, number> {
  // returns a map from index → percentile in [0,1]. Ties resolved by average rank.
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Map<number, number>();
  const n = values.length;
  for (let k = 0; k < n; k++) {
    // average rank across ties
    let j = k;
    while (j + 1 < n && idx[j + 1].v === idx[k].v) j++;
    const avgRank = (k + j) / 2;
    for (let m = k; m <= j; m++) {
      out.set(idx[m].i, n > 1 ? avgRank / (n - 1) : 1);
    }
    k = j;
  }
  return out;
}

export const getResearchLeaders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { slateDate?: string; eligibleOnly?: boolean; includeWaiting?: boolean } | undefined) => data ?? {},
  )
  .handler(async ({ data, context }): Promise<ResearchLeadersPayload> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const slateDate =
      data.slateDate ?? new Date().toISOString().slice(0, 10);
    const eligibleOnly = data.eligibleOnly ?? true;
    const includeWaiting = data.includeWaiting ?? false;

    // 1. Outputs for the slate — current, completed jobs only.
    const markets = RESEARCH_CATEGORIES.map((c) => c.market);
    const { data: outputs, error: oErr } = await supabaseAdmin
      .from("sim_player_outputs")
      .select("*")
      .eq("slate_date", slateDate)
      .in("market", markets)
      .eq("run_status", "current");
    if (oErr) throw new Error(oErr.message);

    const rows = outputs ?? [];
    if (rows.length === 0) {
      return {
        slateDate,
        generatedAt: new Date().toISOString(),
        categories: RESEARCH_CATEGORIES.map((c) => ({ category: c, rows: [], totalCandidates: 0 })),
        filters: { eligibleOnly, includeWaiting },
      };
    }

    // 2. Ancillary lookups.
    const jobIds = Array.from(new Set(rows.map((r) => r.sim_job_id)));
    const gameIds = Array.from(new Set(rows.map((r) => r.game_id)));
    const playerIds = Array.from(new Set(rows.map((r) => r.player_id)));
    const teamIds = Array.from(
      new Set(
        rows.flatMap((r) => [r.team_id, r.opponent_team_id]).filter((x): x is string => !!x),
      ),
    );

    const [
      { data: jobs },
      { data: games },
      { data: players },
      { data: teams },
      { data: lineups },
      { data: starters },
    ] = await Promise.all([
      supabaseAdmin
        .from("sim_jobs")
        .select("id, status, engine_status, inputs_hash, completed_at, tier, label")
        .in("id", jobIds),
      supabaseAdmin
        .from("games")
        .select("id, mlb_game_id, first_pitch_at, home_team_id, away_team_id, lineups_locked_at")
        .in("id", gameIds),
      supabaseAdmin.from("players").select("id, name, mlb_id").in("id", playerIds),
      teamIds.length
        ? supabaseAdmin.from("teams").select("id, abbreviation").in("id", teamIds)
        : Promise.resolve({ data: [] as { id: string; abbreviation: string }[] }),
      supabaseAdmin
        .from("lineups")
        .select("game_id, team_id, player_id, batting_order")
        .in("game_id", gameIds),
      supabaseAdmin
        .from("starting_pitchers")
        .select("game_id, team_id, player_id")
        .in("game_id", gameIds),
    ]);

    const jobById = new Map((jobs ?? []).map((j: any) => [j.id, j]));
    const gameById = new Map((games ?? []).map((g: any) => [g.id, g]));
    const playerById = new Map((players ?? []).map((p: any) => [p.id, p]));
    const teamById = new Map((teams ?? []).map((t: any) => [t.id, t]));

    const lineupByGameTeam = new Map<string, Set<string>>();
    const lineupOrder = new Map<string, number>();
    for (const l of lineups ?? []) {
      const k = `${l.game_id}|${l.team_id}`;
      let s = lineupByGameTeam.get(k);
      if (!s) {
        s = new Set();
        lineupByGameTeam.set(k, s);
      }
      s.add(l.player_id);
      lineupOrder.set(`${l.game_id}|${l.player_id}`, l.batting_order ?? 0);
    }
    const startersByGameTeam = new Map<string, Set<string>>();
    for (const s of starters ?? []) {
      const k = `${s.game_id}|${s.team_id}`;
      let set = startersByGameTeam.get(k);
      if (!set) {
        set = new Set();
        startersByGameTeam.set(k, set);
      }
      set.add(s.player_id);
    }

    // Freshness horizon for forecast: sim job completed within last 4h.
    const now = Date.now();
    const FRESH_MS = 4 * 60 * 60 * 1000;

    // 3. Bucket by category and enrich.
    const catByMarket = new Map(RESEARCH_CATEGORIES.map((c) => [c.market, c]));

    type EnrichedRow = ResearchLeaderRow & { _stabilityScore: number };
    const buckets = new Map<ResearchCategoryKey, EnrichedRow[]>();

    for (const r of rows) {
      const cat = catByMarket.get(r.market);
      if (!cat) continue;
      if (r.player_type !== cat.playerType) continue;

      const job = jobById.get(r.sim_job_id) as any;
      if (!job) continue;
      if (job.status !== "completed") continue; // only completed jobs
      if (job.inputs_hash !== r.inputs_hash) continue; // stale relative to job

      const game = gameById.get(r.game_id) as any;
      const player = playerById.get(r.player_id) as any;
      const teamAbbrev = r.team_id ? (teamById.get(r.team_id) as any)?.abbreviation ?? null : null;
      const oppAbbrev = r.opponent_team_id
        ? (teamById.get(r.opponent_team_id) as any)?.abbreviation ?? null
        : null;

      // Confirmations.
      const lineupSet = lineupByGameTeam.get(`${r.game_id}|${r.team_id}`);
      const lineupConfirmed = !!lineupSet && lineupSet.has(r.player_id);
      const battingOrder =
        r.batting_order ?? lineupOrder.get(`${r.game_id}|${r.player_id}`) ?? null;

      const starterSet = startersByGameTeam.get(`${r.game_id}|${r.team_id}`);
      const oppStarterSet = r.opponent_team_id
        ? startersByGameTeam.get(`${r.game_id}|${r.opponent_team_id}`)
        : undefined;
      const starterConfirmed =
        cat.playerType === "pit" ? !!starterSet && starterSet.has(r.player_id) : true;
      const opposingStarterConfirmed = !!oppStarterSet && oppStarterSet.size > 0;

      const completedAtMs = r.completed_at ? Date.parse(r.completed_at) : 0;
      const forecastFresh = completedAtMs > 0 && now - completedAtMs <= FRESH_MS;

      const engineStatus = (r.engine_status ?? "scaffold_unvalidated") as
        | "scaffold_unvalidated"
        | "validated";

      const statuses: ResearchDataStatus[] = [];
      if (
        (cat.playerType === "bat" && lineupConfirmed) ||
        (cat.playerType === "pit" && starterConfirmed)
      ) {
        statuses.push("CONFIRMED_INPUTS");
      } else if (cat.playerType === "bat") {
        statuses.push("WAITING_ON_LINEUP");
      } else {
        statuses.push("STARTER_UNCONFIRMED");
      }
      if (forecastFresh) statuses.push("FORECAST_FRESH");
      statuses.push("SIM_COMPLETE");
      if (r.run_status === "stale") statuses.push("STALE");

      // Opportunity model.
      const projectedPA = r.projected_pa;
      const projectedBF = r.projected_bf;
      const opportunity =
        cat.playerType === "bat"
          ? projectedPA ?? 0
          : projectedBF ?? (r.market === "k" ? r.projected_mean : 0);

      const strongOpportunity =
        cat.playerType === "bat" ? (projectedPA ?? 0) >= 4 : (projectedBF ?? 0) >= 18;

      const stderr = r.stderr;
      // stability: higher when stderr low OR confidence high.
      const stabilityScore =
        stderr != null && stderr > 0
          ? 1 / stderr
          : r.confidence ?? 0;
      const lowVariance =
        stderr == null ? (r.confidence ?? 0) >= 0.6 : stderr <= Math.max(0.15, r.projected_mean * 0.35);

      const lockEligible =
        engineStatus === "validated" &&
        (cat.playerType === "bat" ? lineupConfirmed : starterConfirmed) &&
        opposingStarterConfirmed &&
        forecastFresh &&
        r.run_status !== "stale";
      if (!lockEligible) statuses.push("NOT_LOCK_ELIGIBLE");

      // --- Simulation iteration transparency ---
      // Read only from persisted job/output data. Never hardcode a count.
      const driverMeta = (r.driver_metadata ?? {}) as Record<string, unknown>;
      const metaIterations =
        typeof driverMeta.iterations === "number" ? (driverMeta.iterations as number) : null;
      let iterations: number | null = null;
      let iterationsSource: ResearchLeaderRow["iterationsSource"] = null;
      if (typeof r.sim_count === "number" && r.sim_count > 0) {
        iterations = r.sim_count;
        iterationsSource = "output.sim_count";
      } else if (metaIterations != null && metaIterations > 0) {
        iterations = metaIterations;
        iterationsSource = "output.driver_metadata.iterations";
      } else if (typeof job.sim_count === "number" && job.sim_count > 0) {
        iterations = job.sim_count;
        iterationsSource = "job.sim_count";
      }
      const iterationsLabel =
        iterations != null
          ? `Simulation: ${iterations.toLocaleString()} runs`
          : "Simulation count unavailable";


      // Confidence tier.
      const inputsStrong =
        (cat.playerType === "bat" ? lineupConfirmed : starterConfirmed) &&
        opposingStarterConfirmed &&
        forecastFresh &&
        r.run_status !== "stale";

      let tier: ResearchConfidenceTier;
      const reasons: string[] = [];
      if (engineStatus === "scaffold_unvalidated") {
        tier = "BETA_UNVALIDATED";
        reasons.push("engine_status = scaffold_unvalidated");
        if (inputsStrong) reasons.push("inputs strong (lineup/starter/forecast/sim current)");
      } else if (iterations == null) {
        // Transparency rule: missing persisted iteration count blocks HEAVY CONFIDENCE.
        tier = "BETA_UNVALIDATED";
        reasons.push("simulation iteration count unavailable from persisted job/output");
      } else if (
        lockEligible &&
        strongOpportunity &&
        lowVariance
      ) {
        tier = "HEAVY_CONFIDENCE";
        reasons.push("validated engine");
        reasons.push(cat.playerType === "bat" ? "confirmed lineup" : "confirmed starter");
        reasons.push("opposing starter confirmed");
        reasons.push("forecast fresh");
        reasons.push(`sim complete and current (${iterations.toLocaleString()} runs)`);
        reasons.push("strong projected opportunity");
        reasons.push("low/moderate simulation variance");
      } else if (inputsStrong) {
        tier = "STRONG_RESEARCH";
        reasons.push("inputs fresh and complete");
        if (!strongOpportunity) reasons.push("lower projected opportunity");
        if (!lowVariance) reasons.push("higher simulation variance");
      } else {
        tier = "WATCHLIST";
        if (cat.playerType === "bat" && !lineupConfirmed) reasons.push("lineup unconfirmed");
        if (cat.playerType === "pit" && !starterConfirmed) reasons.push("starter unconfirmed");
        if (!opposingStarterConfirmed) reasons.push("opposing starter unconfirmed");
        if (!forecastFresh) reasons.push("forecast aging");
        if (r.run_status === "stale") reasons.push("output stale vs current inputs");
      }

      // Why it surfaced — factual, from available fields only.
      const why: string[] = [];
      if (cat.playerType === "bat" && battingOrder) why.push(`Lineup slot ${battingOrder}`);
      if (cat.playerType === "bat" && projectedPA != null) why.push(`projected ${projectedPA.toFixed(1)} PA`);
      if (cat.playerType === "pit" && projectedBF != null) why.push(`projected ${projectedBF.toFixed(1)} BF`);
      why.push(`${cat.eventLabel} prob ${(r.event_probability * 100).toFixed(1)}%`);
      why.push(`proj mean ${r.projected_mean.toFixed(2)}`);
      if (forecastFresh) why.push("forecast fresh");
      why.push(iterationsLabel.toLowerCase());


      const enriched: EnrichedRow = {
        rank: 0,
        category: cat.key,
        playerId: r.player_id,
        playerName: player?.name ?? "Unknown",
        mlbId: player?.mlb_id ?? null,
        playerType: cat.playerType,
        teamAbbrev,
        oppAbbrev,
        gameId: r.game_id,
        gamePk: r.game_pk,
        firstPitchAt: game?.first_pitch_at ?? null,
        eventLabel: cat.eventLabel,
        eventProbability: r.event_probability,
        projectedMean: r.projected_mean,
        threshold: r.threshold,
        projectedPA,
        projectedBF,
        battingOrder,
        stderr,
        confidence: r.confidence,
        engineStatus,
        runStatus: r.run_status,
        simTier: r.sim_tier,
        simCount: r.sim_count,
        simJobId: r.sim_job_id,
        jobStatus: job.status,
        inputsHash: r.inputs_hash,
        completedAt: r.completed_at,
        lineupConfirmed,
        starterConfirmed,
        opposingStarterConfirmed,
        forecastFresh,
        lockEligible,
        dataStatuses: statuses,
        confidenceTier: tier,
        confidenceReasons: reasons,
        inputsStrong,
        researchSignal: 0,
        whyItSurfaced: why.join(" · "),
        _stabilityScore: stabilityScore,
      };

      // Filters
      if (eligibleOnly && !enriched.lockEligible && engineStatus !== "scaffold_unvalidated") {
        // Allow scaffold rows through so admins can still see the plumbing.
        continue;
      }
      if (!includeWaiting) {
        // Hide rows waiting on lineup/starter (unless they're already lock-eligible).
        if (
          !enriched.lockEligible &&
          (statuses.includes("WAITING_ON_LINEUP") || statuses.includes("STARTER_UNCONFIRMED"))
        ) {
          continue;
        }
      }

      const arr = buckets.get(cat.key) ?? [];
      arr.push(enriched);
      buckets.set(cat.key, arr);
    }

    // 4. Rank each category independently.
    const sections: ResearchCategorySection[] = RESEARCH_CATEGORIES.map((cat) => {
      const arr = buckets.get(cat.key) ?? [];
      if (arr.length === 0) return { category: cat, rows: [], totalCandidates: 0 };

      const probs = arr.map((r) => r.eventProbability);
      const opps = arr.map((r) =>
        cat.playerType === "bat" ? r.projectedPA ?? 0 : r.projectedBF ?? r.projectedMean,
      );
      const stabs = arr.map((r) => r._stabilityScore);

      const pProb = percentileRank(probs);
      const pOpp = percentileRank(opps);
      const pStab = percentileRank(stabs);

      arr.forEach((r, i) => {
        const signal =
          0.55 * (pProb.get(i) ?? 0) +
          0.25 * (pOpp.get(i) ?? 0) +
          0.20 * (pStab.get(i) ?? 0);
        r.researchSignal = Math.round(signal * 100);
      });

      arr.sort((a, b) => {
        if (b.eventProbability !== a.eventProbability) return b.eventProbability - a.eventProbability;
        const oa = cat.playerType === "bat" ? a.projectedPA ?? 0 : a.projectedBF ?? a.projectedMean;
        const ob = cat.playerType === "bat" ? b.projectedPA ?? 0 : b.projectedBF ?? b.projectedMean;
        if (ob !== oa) return ob - oa;
        return b._stabilityScore - a._stabilityScore;
      });

      const top = arr.slice(0, 25).map((r, i) => {
        const { _stabilityScore, ...rest } = r;
        void _stabilityScore;
        return { ...rest, rank: i + 1 };
      });

      return { category: cat, rows: top, totalCandidates: arr.length };
    }).filter((s) => s.rows.length > 0 || RESEARCH_CATEGORIES.some((c) => c.key === s.category.key));

    return {
      slateDate,
      generatedAt: new Date().toISOString(),
      categories: sections,
      filters: { eligibleOnly, includeWaiting },
    };
  });
