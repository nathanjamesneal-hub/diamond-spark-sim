import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { todayInAppTz } from "@/lib/timezone";

export type FeaturedLeg = {
  id: string;
  tier: string;
  rank: number | null;
  playerId: string | null;
  playerName: string | null;
  gameId: string | null;
  gameLabel: string | null;
  opponentLabel: string | null;
  market: string;
  side: string;
  line: number | null;
  price: number | null;
  diamondProbability: number | null;
  novigProbability: number | null;
  edgePp: number | null;
  recommendationScore: number | null;
  projectionStage: string | null;
  engineStatus: string | null;
  uncertainty: any;
  form: any;
  matchup: any;
  why: any;
  rejectReason: string | null;
};

export type FeaturedTicket = {
  id: string;
  kind: "double" | "triple" | "higher_upside";
  legIds: string[];
  estimatedCombinedProbability: number | null;
  minLegProbability: number | null;
  minRecommendationScore: number | null;
};

export type FeaturedRun = {
  runId: string | null;
  state: "LIVE" | "OFFICIAL" | null;
  slateDate: string;
  generatedAt: string | null;
  modelVersion: string | null;
  formulaVersion: string | null;
  snapshotId: string | null;
  candidatePoolSize: number;
  bestBet: FeaturedLeg | null;
  featured: FeaturedLeg[];
  unvalidatedPreview: FeaturedLeg[];
  rejected: FeaturedLeg[];
  tickets: FeaturedTicket[];
};

async function loadFeaturedRunFor(
  supabase: any,
  slateDate: string,
  state: "LIVE" | "OFFICIAL",
): Promise<FeaturedRun> {
  const emptyRun: FeaturedRun = {
    runId: null, state, slateDate, generatedAt: null, modelVersion: null,
    formulaVersion: null, snapshotId: null, candidatePoolSize: 0,
    bestBet: null, featured: [], unvalidatedPreview: [], rejected: [], tickets: [],
  };
  let q = supabase.from("recommendation_runs")
    .select("id, state, slate_date, generated_at, model_version, formula_version, snapshot_id, candidate_pool_size")
    .eq("slate_date", slateDate)
    .eq("state", state)
    .order("generated_at", { ascending: false })
    .limit(1);
  if (state === "LIVE") q = q.is("superseded_at", null);
  const { data: run } = await q.maybeSingle();
  if (!run) return emptyRun;

  const [legsRes, ticketsRes] = await Promise.all([
    supabase.from("recommendation_legs")
      .select(`
        id, tier, rank, player_id, game_id, market, side, line, sportsbook_price,
        diamond_probability, novig_probability, edge_pp, recommendation_score,
        projection_stage, engine_status, uncertainty, form, matchup, why, reject_reason,
        player:players (full_name),
        game:games (mlb_game_id, home_team_id, away_team_id, home_team:teams!games_home_team_id_fkey(abbreviation), away_team:teams!games_away_team_id_fkey(abbreviation))
      `)
      .eq("run_id", run.id),
    supabase.from("recommendation_tickets").select("*").eq("run_id", run.id),
  ]);

  const mapLeg = (l: any): FeaturedLeg => {
    const home = l.game?.home_team?.abbreviation ?? "";
    const away = l.game?.away_team?.abbreviation ?? "";
    return {
      id: l.id, tier: l.tier, rank: l.rank,
      playerId: l.player_id, playerName: l.player?.full_name ?? null,
      gameId: l.game_id,
      gameLabel: home && away ? `${away} @ ${home}` : null,
      opponentLabel: home && away ? `${home}/${away}` : null,
      market: l.market, side: l.side, line: l.line,
      price: l.sportsbook_price,
      diamondProbability: l.diamond_probability,
      novigProbability: l.novig_probability,
      edgePp: l.edge_pp,
      recommendationScore: l.recommendation_score,
      projectionStage: l.projection_stage,
      engineStatus: l.engine_status,
      uncertainty: l.uncertainty, form: l.form, matchup: l.matchup, why: l.why,
      rejectReason: l.reject_reason,
    };
  };
  const legs: FeaturedLeg[] = (legsRes.data ?? []).map(mapLeg);
  const bestBet = legs.find((l: FeaturedLeg) => l.tier === "best_bet") ?? null;
  const featured = legs.filter((l: FeaturedLeg) => l.tier === "featured").sort((a: FeaturedLeg, b: FeaturedLeg) => (a.rank ?? 99) - (b.rank ?? 99));
  const unvalidatedPreview = legs.filter((l: FeaturedLeg) => l.tier === "unvalidated_preview").sort((a: FeaturedLeg, b: FeaturedLeg) => (a.rank ?? 99) - (b.rank ?? 99));
  const rejected = legs.filter((l: FeaturedLeg) => l.tier === "rejected");

  return {
    runId: run.id, state: run.state, slateDate: run.slate_date, generatedAt: run.generated_at,
    modelVersion: run.model_version, formulaVersion: run.formula_version,
    snapshotId: run.snapshot_id, candidatePoolSize: run.candidate_pool_size,
    bestBet, featured, unvalidatedPreview, rejected,
    tickets: (ticketsRes.data ?? []).map((t: any) => ({
      id: t.id, kind: t.kind, legIds: t.leg_ids,
      estimatedCombinedProbability: t.estimated_combined_probability,
      minLegProbability: t.min_leg_probability,
      minRecommendationScore: t.min_recommendation_score,
    })),
  };
}

export const getFeaturedRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data?: { date?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<{ live: FeaturedRun; official: FeaturedRun; slateDate: string }> => {
    const slateDate = data?.date ?? todayInAppTz();
    const [live, official] = await Promise.all([
      loadFeaturedRunFor(context.supabase, slateDate, "LIVE"),
      loadFeaturedRunFor(context.supabase, slateDate, "OFFICIAL"),
    ]);
    return { live, official, slateDate };
  });

export const buildLiveRecommendationsNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data?: { date?: string }) => data ?? {})
  .handler(async ({ data, context }) => {
    const slateDate = data?.date ?? todayInAppTz();
    // Verify caller is admin before running the builder from a UI button.
    const { data: isAdmin } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Forbidden");
    const { buildRecommendations } = await import("./build.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return buildRecommendations(supabaseAdmin, { slateDate, state: "LIVE" });
  });
