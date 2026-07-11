/**
 * Prop Board — LIVE build (Phase A).
 *
 * Reads persisted sim_player_outputs and joins games + game_lineup_status +
 * projections.matchup_grade + players. For each (player, market) picks the
 * newest completed output whose projection_stage is the freshest available
 * for that game. Applies the transparent prop_quality_score, tiers, and
 * reason codes from ./score. No fabrication — missing signals surface as
 * `null` and are handled by the scorer via weight redistribution.
 */
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  scoreCandidate,
  normalizeWithinMarket,
  MARKET_META,
  SUPPORTED_MARKETS,
  type PropMarket,
  type ScoreOutput,
  type FormDirection,
} from "./score";

export type PropBoardRow = {
  key: string;
  playerId: string;
  playerName: string;
  mlbId: number | null;
  teamAbbrev: string;
  oppAbbrev: string;
  gameId: string;
  gamePk: number | null;
  firstPitchAt: string | null;
  market: PropMarket;
  marketLabel: string;
  line: string;
  threshold: number | null;
  eventProbability: number | null;
  projectedMean: number | null;
  meanUnit: string;
  simCount: number | null;
  stderr: number | null;
  confidence: number | null;
  formDirection: FormDirection | null;
  formSampleSize: number | null;
  formReliability: number | null;
  matchupGrade: number | null;
  lineupStatus: "confirmed" | "expected" | "projected" | "unknown";
  projectionStage: string | null;
  engineStatus: string | null;
  inputsHash: string | null;
  modelVersion: string | null;
  lastUpdated: string;
  isPreview: boolean;
  battingOrder: number | null;
  score: ScoreOutput["score"];
  tier: ScoreOutput["tier"];
  reasons: ScoreOutput["reasons"];
  mode: ScoreOutput["mode"];
  components: ScoreOutput["components"];
  rankInMarket: number;
  isPitcher: boolean;
};

export type PropBoardPayload = {
  slateDate: string;
  generatedAt: string;
  mode: "live";
  boards: Array<{
    market: PropMarket;
    label: string;
    line: string;
    role: "hitter" | "pitcher";
    heavy: PropBoardRow[];
    strong: PropBoardRow[];
    watchlist: PropBoardRow[];
    preview: PropBoardRow[];
    excluded: PropBoardRow[];
    unavailable?: string; // reason if no persisted MC for this market on this slate
  }>;
  bestOf: Array<{ label: string; market: PropMarket; row: PropBoardRow | null }>;
  totals: {
    considered: number;
    heavy: number;
    strong: number;
    watchlist: number;
    preview: number;
    excluded: number;
  };
};

function serverClient() {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
  );
}

function todayLocalIso(): string {
  const now = new Date();
  const est = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return est.toISOString().slice(0, 10);
}

function stageOrder(stage: string | null): number {
  switch ((stage ?? "").toLowerCase()) {
    case "final_pregame": return 4;
    case "lineup_confirmed": return 3;
    case "updated": return 2;
    case "early": return 1;
    default: return 0;
  }
}

function mapLineupStatus(row: { status: string | null; confidence: number | null } | null): "confirmed" | "expected" | "projected" | "unknown" {
  if (!row?.status) return "unknown";
  const s = row.status.toLowerCase();
  if (s === "confirmed" || s === "official" || s === "locked") return "confirmed";
  if (s === "expected" || s === "aggregated") return "expected";
  if (s === "projected" || s === "estimated") return "projected";
  return "unknown";
}

export const getPropBoardLive = createServerFn({ method: "GET" })
  .inputValidator((data: { date?: string } | undefined) => ({ date: data?.date }))
  .handler(async ({ data }): Promise<PropBoardPayload> => {
    const slateDate = data.date ?? todayLocalIso();
    const sb = serverClient();

    // 1. Sim outputs for the slate.
    const { data: sims, error: simErr } = await sb
      .from("sim_player_outputs")
      .select(
        "id, player_id, game_id, game_pk, market, threshold, projected_mean, event_probability, sim_count, stderr, confidence, form_direction, form_prob_adjustment, form_sample_size, form_reliability, projection_stage, engine_status, inputs_hash, model_version, run_status, batting_order, opponent_team_id, team_id, player_type, completed_at, created_at",
      )
      .eq("slate_date", slateDate)
      .in("run_status", ["current","completed","success","ok"])
      .in("market", SUPPORTED_MARKETS as unknown as string[]);
    if (simErr) throw new Error(`prop-board sims: ${simErr.message}`);

    // Also detect newer pending sims per (player, market).
    const { data: pending } = await sb
      .from("sim_player_outputs")
      .select("player_id, market, created_at")
      .eq("slate_date", slateDate)
      .in("run_status", ["pending", "running", "queued"]);
    const pendingKey = new Set<string>();
    for (const p of pending ?? []) pendingKey.add(`${p.player_id}:${p.market}`);

    // 2. Dedupe: newest projection_stage → newest completed_at.
    const bestPerKey = new Map<string, typeof sims[number]>();
    for (const s of sims ?? []) {
      const k = `${s.player_id}:${s.game_id}:${s.market}:${s.threshold ?? "-"}`;
      const prev = bestPerKey.get(k);
      if (!prev) { bestPerKey.set(k, s); continue; }
      const a = stageOrder(s.projection_stage);
      const b = stageOrder(prev.projection_stage);
      if (a > b) { bestPerKey.set(k, s); continue; }
      if (a === b && new Date(s.completed_at) > new Date(prev.completed_at)) {
        bestPerKey.set(k, s);
      }
    }
    const rows = Array.from(bestPerKey.values());

    // 3. Fetch related joins in bulk.
    const gameIds = Array.from(new Set(rows.map((r) => r.game_id)));
    const playerIds = Array.from(new Set(rows.map((r) => r.player_id)));

    const [{ data: games }, { data: lineupStatus }, { data: players }, { data: teams }, { data: projections }] =
      await Promise.all([
        sb.from("games").select("id, mlb_game_id, first_pitch_at, home_team_id, away_team_id, game_status").in("id", gameIds),
        sb.from("game_lineup_status").select("game_id, status, confidence").in("game_id", gameIds),
        sb.from("players").select("id, name, mlb_id").in("id", playerIds),
        sb.from("teams").select("id, abbreviation"),
        sb
          .from("projections")
          .select("player_id, game_id, matchup_grade, created_at")
          .in("player_id", playerIds)
          .in("game_id", gameIds),
      ]);

    const gameMap = new Map((games ?? []).map((g) => [g.id, g]));
    const lineupMap = new Map((lineupStatus ?? []).map((l) => [l.game_id, l]));
    const playerMap = new Map((players ?? []).map((p) => [p.id, p]));
    const teamMap = new Map((teams ?? []).map((t) => [t.id, t.abbreviation ?? ""]));

    // Newest matchup grade per (player, game).
    const matchupMap = new Map<string, number | null>();
    for (const p of projections ?? []) {
      const k = `${p.player_id}:${p.game_id}`;
      const prev = matchupMap.get(k);
      if (prev == null || (p.matchup_grade != null && p.matchup_grade > 0)) {
        matchupMap.set(k, p.matchup_grade ?? null);
      }
    }

    const now = Date.now();

    // 4. Score every row.
    type Scored = PropBoardRow;
    const scored: Scored[] = rows.map((r) => {
      const g = gameMap.get(r.game_id);
      const ls = lineupMap.get(r.game_id) ?? null;
      const p = playerMap.get(r.player_id);
      const teamAbbrev = teamMap.get(r.team_id ?? "") ?? "";
      const oppAbbrev = teamMap.get(r.opponent_team_id ?? "") ?? "";
      const market = r.market as PropMarket;
      const meta = MARKET_META[market];
      const matchupGrade = matchupMap.get(`${r.player_id}:${r.game_id}`) ?? null;
      const lineupStatus = mapLineupStatus(ls);
      const newerPending = pendingKey.has(`${r.player_id}:${r.market}`);
      const ageMinutes = Math.max(0, Math.round((now - new Date(r.completed_at).getTime()) / 60000));
      const engineStatus = r.engine_status ?? null;
      const gameStarted = ["in_progress", "final", "completed"].includes((g?.game_status ?? "").toLowerCase());

      const scoreOut = scoreCandidate({
        market,
        eventProbability: r.event_probability ?? null,
        projectedMean: r.projected_mean ?? null,
        threshold: r.threshold ?? null,
        simCount: r.sim_count ?? null,
        stderr: r.stderr ?? null,
        confidence: r.confidence ?? null,
        formDirection: (r.form_direction as FormDirection | null) ?? null,
        formProbAdjustment: r.form_prob_adjustment ?? null,
        formSampleSize: r.form_sample_size ?? null,
        formReliability: r.form_reliability ?? null,
        matchupGrade,
        lineupStatus,
        projectionStage: r.projection_stage,
        newerSimPending: newerPending,
        ageMinutes,
        engineStatus,
        hasMarketPrice: false,
        noVigMarketProb: null,
      });

      // Post-hoc: if the game has started, force exclusion.
      const reasons = scoreOut.reasons.slice();
      let excluded = scoreOut.excluded;
      let tier = scoreOut.tier;
      if (gameStarted) {
        excluded = true;
        tier = "excluded";
        if (!reasons.includes("game_started")) reasons.push("game_started");
      }

      return {
        key: `${r.player_id}:${r.game_id}:${r.market}:${r.threshold ?? "-"}`,
        playerId: r.player_id,
        playerName: p?.name ?? r.player_id,
        mlbId: p?.mlb_id ?? null,
        teamAbbrev,
        oppAbbrev,
        gameId: r.game_id,
        gamePk: r.game_pk ?? g?.mlb_game_id ?? null,
        firstPitchAt: g?.first_pitch_at ?? null,
        market,
        marketLabel: meta.label,
        line: r.threshold != null ? `${r.threshold}+ ${meta.unit}` : meta.line,
        threshold: r.threshold ?? null,
        eventProbability: r.event_probability ?? null,
        projectedMean: r.projected_mean ?? null,
        meanUnit: meta.unit,
        simCount: r.sim_count ?? null,
        stderr: r.stderr ?? null,
        confidence: r.confidence ?? null,
        formDirection: (r.form_direction as FormDirection | null) ?? null,
        formSampleSize: r.form_sample_size ?? null,
        formReliability: r.form_reliability ?? null,
        matchupGrade,
        lineupStatus,
        projectionStage: r.projection_stage,
        engineStatus,
        inputsHash: r.inputs_hash,
        modelVersion: r.model_version,
        lastUpdated: r.completed_at,
        isPreview: (() => { const es = (engineStatus ?? "").toLowerCase(); return es === "scaffold_unvalidated" || es === "diamond_mc_candidate"; })(),
        battingOrder: r.batting_order ?? null,
        score: scoreOut.score,
        tier,
        reasons,
        mode: scoreOut.mode,
        components: scoreOut.components,
        rankInMarket: 0,
        isPitcher: r.player_type === "pit" || meta.role === "pitcher",
      };
    });

    // 5. Group by market, normalize scores within market, rank.
    const boards: PropBoardPayload["boards"] = SUPPORTED_MARKETS.map((market) => {
      const meta = MARKET_META[market];
      const marketRows = scored.filter((r) => r.market === market);
      const normalized = normalizeWithinMarket(marketRows).sort((a, b) => {
        // sort by tier priority then score desc
        const order = { heavy: 0, strong: 1, watchlist: 2, preview: 3, excluded: 4 } as const;
        const d = order[a.tier] - order[b.tier];
        if (d !== 0) return d;
        return b.score - a.score;
      });
      normalized.forEach((r, i) => { r.rankInMarket = i + 1; });

      return {
        market,
        label: meta.label,
        line: meta.line,
        role: meta.role,
        heavy: normalized.filter((r) => r.tier === "heavy").slice(0, 25),
        strong: normalized.filter((r) => r.tier === "strong").slice(0, 25),
        watchlist: normalized.filter((r) => r.tier === "watchlist").slice(0, 25),
        preview: normalized.filter((r) => r.tier === "preview").slice(0, 25),
        excluded: normalized.filter((r) => r.tier === "excluded").slice(0, 25),
        unavailable: normalized.length === 0 ? "No persisted Monte Carlo outputs for this market on the selected slate." : undefined,
      };
    });

    const bestOf: PropBoardPayload["bestOf"] = [
      { label: "Best 1+ Hit",    market: "1plus_hit",  row: pickBest(boards, "1plus_hit") },
      { label: "Best 2+ Hits",   market: "2plus_hits", row: pickBest(boards, "2plus_hits") },
      { label: "Best Total Bases", market: "total_bases", row: pickBest(boards, "total_bases") },
      { label: "Best Home Run",  market: "hr",         row: pickBest(boards, "hr") },
      { label: "Best K's",       market: "k",          row: pickBest(boards, "k") },
      { label: "Best Outs",      market: "outs",       row: pickBest(boards, "outs") },
      { label: "Best Under ER",  market: "er",         row: pickBest(boards, "er") },
    ];

    const totals = {
      considered: scored.length,
      heavy: scored.filter((r) => r.tier === "heavy").length,
      strong: scored.filter((r) => r.tier === "strong").length,
      watchlist: scored.filter((r) => r.tier === "watchlist").length,
      preview: scored.filter((r) => r.tier === "preview").length,
      excluded: scored.filter((r) => r.tier === "excluded").length,
    };

    return {
      slateDate,
      generatedAt: new Date().toISOString(),
      mode: "live",
      boards,
      bestOf,
      totals,
    };
  });

function pickBest(boards: PropBoardPayload["boards"], m: PropMarket): PropBoardRow | null {
  const b = boards.find((x) => x.market === m);
  if (!b) return null;
  return b.heavy[0] ?? b.strong[0] ?? null;
}
