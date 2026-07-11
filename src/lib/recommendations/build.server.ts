/**
 * Diamond recommendation builder — server-only.
 *
 * Reads:
 *   - LIVE:     latest completed sim_player_outputs per (game, player, market)
 *               for the slate.
 *   - OFFICIAL: sim_player_outputs pinned to snapshot.sim_job_id + inputs_hash,
 *               or (when snapshot has no sim_job_id) rows whose inputs_hash
 *               matches the snapshot's inputs_hash for that game.
 *
 * Never mutates prediction, Diamond Score, or projection tables.
 * Only writes into: recommendation_runs, recommendation_legs, recommendation_tickets.
 *
 * LIVE supersession:
 *   - Marks the previously-active LIVE run for the same slate as superseded.
 *   - OFFICIAL runs are immutable; a new OFFICIAL run replaces via meta-only
 *     link, but the prior official row is kept and never overwritten.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FORMULA_VERSION,
  americanToImplied,
  twoSidedNoVig,
  expectedValue,
  scoreRecommendation,
  estimatedCombinedProbability,
} from "./formulas";
import {
  checkLegEligibility,
  isValidatedEngineStatus,
  pickBestBetAndFeatured,
  assembleTicket,
  RECOMMENDATION_THRESHOLDS,
} from "./eligibility";

const SUPPORTED_MARKETS = new Set(["hits", "total_bases", "runs_scored", "rbis", "hr", "strikeouts", "outs_recorded"]);
const STARTED_STATUS_RX = /(in progress|live|final|game over|completed)/i;

export type BuildRecommendationsOpts = {
  slateDate: string;
  state: "LIVE" | "OFFICIAL";
  snapshotId?: string | null;
  gameId?: string | null;
};

export type BuildResult = {
  runId: string | null;
  state: "LIVE" | "OFFICIAL";
  slateDate: string;
  candidatePool: number;
  eligibleCount: number;
  featuredCount: number;
  bestBet: boolean;
  tickets: { double: boolean; triple: boolean; higherUpside: boolean };
  unvalidatedPreviewCount: number;
  supersededRuns: number;
  reason?: string;
};

export async function buildRecommendations(
  admin: SupabaseClient<any>,
  opts: BuildRecommendationsOpts,
): Promise<BuildResult> {
  const nowIso = new Date().toISOString();
  const result: BuildResult = {
    runId: null, state: opts.state, slateDate: opts.slateDate,
    candidatePool: 0, eligibleCount: 0, featuredCount: 0, bestBet: false,
    tickets: { double: false, triple: false, higherUpside: false },
    unvalidatedPreviewCount: 0, supersededRuns: 0,
  };

  // 1. Load games for slate + game statuses.
  const { data: games } = await admin
    .from("games")
    .select("id, mlb_game_id, first_pitch_at, game_status, date")
    .eq("date", opts.slateDate);
  const gameMap = new Map<string, any>((games ?? []).map((g: any) => [g.id, g]));

  // 2. Load raw sim outputs — LIVE = latest completed; OFFICIAL = snapshot-pinned.
  let simRows: any[] = [];
  let modelVersion = "unknown";
  let pinnedInputsHash: string | null = null;
  let snapshotSimJobId: string | null = null;

  if (opts.state === "OFFICIAL") {
    if (!opts.snapshotId) return { ...result, reason: "official_requires_snapshot_id" };
    const { data: snap } = await admin
      .from("engine_beta_snapshots")
      .select("id, game_id, slate_date, sim_job_id, inputs_hash, engine_status")
      .eq("id", opts.snapshotId).maybeSingle();
    if (!snap) return { ...result, reason: "snapshot_not_found" };
    snapshotSimJobId = snap.sim_job_id ?? null;
    pinnedInputsHash = snap.inputs_hash ?? null;
    let q = admin.from("sim_player_outputs")
      .select("*")
      .eq("slate_date", opts.slateDate)
      .eq("run_status", "completed");
    if (snap.game_id) q = q.eq("game_id", snap.game_id);
    if (snapshotSimJobId) q = q.eq("sim_job_id", snapshotSimJobId);
    else if (pinnedInputsHash) q = q.eq("inputs_hash", pinnedInputsHash);
    const { data } = await q;
    simRows = data ?? [];
  } else {
    const { data } = await admin
      .from("sim_player_outputs")
      .select("*")
      .eq("slate_date", opts.slateDate)
      .eq("run_status", "completed")
      .order("completed_at", { ascending: false });
    simRows = data ?? [];
  }
  if (simRows[0]) modelVersion = simRows[0].model_version;

  // 3. Deduplicate: latest row per (game_id, player_id, market, threshold, side).
  //    "Side" is inferred by market; we take both projected_mean and event_probability.
  const dedup = new Map<string, any>();
  for (const r of simRows) {
    const key = `${r.game_id}|${r.player_id}|${r.market}|${r.threshold ?? "-"}`;
    if (!dedup.has(key)) dedup.set(key, r);
  }
  const rows = Array.from(dedup.values());

  // 4. Load lineups + starters for eligibility.
  const gameIds = Array.from(new Set(rows.map((r) => r.game_id)));
  const [lineupsRes, startersRes] = await Promise.all([
    admin.from("lineups").select("game_id, player_id, confirmed, lineup_status").in("game_id", gameIds.length ? gameIds : ["-"]),
    admin.from("starting_pitchers").select("game_id, player_id, confirmed").in("game_id", gameIds.length ? gameIds : ["-"]),
  ]);
  const inLineup = new Set<string>((lineupsRes.data ?? []).map((l: any) => `${l.game_id}|${l.player_id}`));
  const isStarter = new Set<string>((startersRes.data ?? []).map((s: any) => `${s.game_id}|${s.player_id}`));

  // 5. Load newer pending sim jobs for those games.
  const { data: pendingJobs } = await admin
    .from("sim_jobs")
    .select("game_id, status, created_at")
    .in("game_id", gameIds.length ? gameIds : ["-"])
    .in("status", ["queued", "running"]);
  const newerPendingByGame = new Set<string>((pendingJobs ?? []).map((j: any) => j.game_id));

  // 6. Score every candidate; classify as eligible / rejected / unvalidated_preview.
  type Candidate = {
    row: any;
    side: "over" | "under";
    diamondProbability: number;
    novigProbability: number | null;
    edgePp: number | null;
    ev: number | null;
    price: number | null;
    score: number;
    scoreBreakdown: any;
    probabilityOnly: boolean;
    engineValidated: boolean;
    eligibility: ReturnType<typeof checkLegEligibility>;
  };

  const candidates: Candidate[] = [];
  for (const r of rows) {
    const g = gameMap.get(r.game_id);
    const gameStarted = g?.game_status ? STARTED_STATUS_RX.test(String(g.game_status)) : false;
    const supported = SUPPORTED_MARKETS.has(String(r.market));
    const playerInLineup = inLineup.has(`${r.game_id}|${r.player_id}`);
    const isSp = isStarter.has(`${r.game_id}|${r.player_id}`);
    const engineValidated = isValidatedEngineStatus(r.engine_status);

    // Choose the more confident side by event_probability >= 0.5
    const side: "over" | "under" = (r.event_probability ?? 0.5) >= 0.5 ? "over" : "under";
    const diamondProbability = side === "over" ? r.event_probability : 1 - (r.event_probability ?? 0.5);

    // Market data — this schema does not have first-class prices; keep null in v1.
    const price: number | null = null;
    const novigProbability: number | null = null;
    const edgePp: number | null = null;
    const ev: number | null = null;

    const scored = scoreRecommendation({
      diamondProbability,
      novigProbability,
      edgePp,
      stderr: r.stderr,
      confidence: r.confidence,
      simCount: r.sim_count ?? 0,
      formDirection: r.form_direction as any,
      formReliability: r.form_reliability,
      matchupQuality: null,
    });

    const eligibility = checkLegEligibility({
      runStatus: r.run_status,
      engineStatus: r.engine_status,
      simCount: r.sim_count ?? 0,
      stderr: r.stderr,
      projectionStage: r.projection_stage,
      projectionCompletedAt: r.completed_at,
      playerInLineup,
      isStartingPitcher: isSp,
      gameStarted,
      newerSimPending: newerPendingByGame.has(r.game_id),
      supportedMarket: supported,
      hasMarketPrice: price != null,
      diamondProbability,
      edgePp,
      score: scored.score,
      requiresMarketEdge: false, // probability-only tier in v1 until prices are wired
    });

    candidates.push({
      row: r, side, diamondProbability, novigProbability, edgePp, ev, price,
      score: scored.score, scoreBreakdown: scored.breakdown,
      probabilityOnly: scored.probabilityOnly, engineValidated, eligibility,
    });
  }

  result.candidatePool = candidates.length;

  const eligible = candidates.filter((c) => c.eligibility.ok && c.engineValidated);
  const unvalidatedPreview = candidates.filter((c) => !c.engineValidated && (c.eligibility.ok || (c.eligibility as any).reason === "engine_not_validated"));
  const rejected = candidates.filter((c) => !c.eligibility.ok && c.engineValidated);

  result.eligibleCount = eligible.length;
  result.unvalidatedPreviewCount = unvalidatedPreview.length;

  // 7. Best bet + featured
  const withKeys = eligible.map((c) => ({
    ...c,
    playerId: c.row.player_id,
    gameId: c.row.game_id,
    probability: c.diamondProbability,
  }));
  const { bestBet, featured } = pickBestBetAndFeatured(withKeys, 5);
  result.bestBet = bestBet != null;
  result.featuredCount = featured.length;

  // 8. Tickets
  const doubleTicket = assembleTicket(withKeys, 2);
  const tripleTicket = assembleTicket(withKeys, 3);
  const higherUpsideTicket = assembleTicket(withKeys, 3, {
    minProb: RECOMMENDATION_THRESHOLDS.HIGHER_UPSIDE_MIN_LEG_PROB,
    minScore: RECOMMENDATION_THRESHOLDS.HIGHER_UPSIDE_MIN_LEG_SCORE,
  });
  result.tickets.double = doubleTicket != null;
  result.tickets.triple = tripleTicket != null;
  result.tickets.higherUpside = higherUpsideTicket != null && !tripleTicket;

  // 9. Create the recommendation_runs row.
  const { data: run, error: runErr } = await admin
    .from("recommendation_runs")
    .insert({
      slate_date: opts.slateDate,
      state: opts.state,
      model_version: modelVersion,
      formula_version: FORMULA_VERSION,
      snapshot_id: opts.snapshotId ?? null,
      game_id: opts.gameId ?? null,
      generated_at: nowIso,
      candidate_pool_size: candidates.length,
      selected_count: (bestBet ? 1 : 0) + featured.length,
      status: "active",
      meta: {
        pinnedInputsHash, snapshotSimJobId,
        thresholds: RECOMMENDATION_THRESHOLDS,
        counts: {
          eligible: eligible.length,
          rejected: rejected.length,
          unvalidatedPreview: unvalidatedPreview.length,
        },
      },
    })
    .select("id")
    .single();
  if (runErr || !run) return { ...result, reason: `run insert: ${runErr?.message}` };
  const runId = run.id as string;
  result.runId = runId;

  // 10. Insert all legs — selected, unvalidated preview, and rejected (with reason).
  const legInserts: any[] = [];
  const legIdBySelected = new Map<Candidate, number>();
  const push = (tier: string, rank: number | null, c: Candidate) => {
    legIdBySelected.set(c, legInserts.length);
    legInserts.push({
      run_id: runId, tier, rank,
      player_id: c.row.player_id, game_id: c.row.game_id,
      market: c.row.market, side: c.side, line: c.row.threshold,
      sportsbook_price: c.price, diamond_probability: c.diamondProbability,
      novig_probability: c.novigProbability, edge_pp: c.edgePp,
      expected_value: c.ev, recommendation_score: c.score,
      sim_job_id: c.row.sim_job_id, sim_output_id: c.row.id,
      engine_status: c.row.engine_status, projection_stage: c.row.projection_stage,
      uncertainty: { stderr: c.row.stderr, confidence: c.row.confidence, sim_count: c.row.sim_count },
      form: { direction: c.row.form_direction, reliability: c.row.form_reliability, sample_size: c.row.form_sample_size },
      matchup: {},
      why: { breakdown: c.scoreBreakdown, probabilityOnly: c.probabilityOnly },
      reject_reason: null,
      reject_details: null,
    });
  };
  if (bestBet) push("best_bet", 1, bestBet as Candidate);
  featured.forEach((f, i) => push("featured", i + 1, f as Candidate));
  unvalidatedPreview.forEach((c, i) => push("unvalidated_preview", i + 1, c));
  rejected.forEach((c) => {
    const r = (c.eligibility as any).reason as string;
    legInserts.push({
      run_id: runId, tier: "rejected", rank: null,
      player_id: c.row.player_id, game_id: c.row.game_id,
      market: c.row.market, side: c.side, line: c.row.threshold,
      sportsbook_price: c.price, diamond_probability: c.diamondProbability,
      novig_probability: c.novigProbability, edge_pp: c.edgePp,
      expected_value: c.ev, recommendation_score: c.score,
      sim_job_id: c.row.sim_job_id, sim_output_id: c.row.id,
      engine_status: c.row.engine_status, projection_stage: c.row.projection_stage,
      uncertainty: { stderr: c.row.stderr, confidence: c.row.confidence, sim_count: c.row.sim_count },
      form: {}, matchup: {}, why: {},
      reject_reason: r,
      reject_details: null,
    });
  });

  if (legInserts.length) {
    const { error: legErr } = await admin.from("recommendation_legs").insert(legInserts);
    if (legErr) return { ...result, reason: `leg insert: ${legErr.message}` };
  }

  // 11. Tickets — re-read persisted leg IDs by (sim_output_id) so we can link.
  const { data: persistedLegs } = await admin
    .from("recommendation_legs")
    .select("id, sim_output_id, tier")
    .eq("run_id", runId);
  const legIdBySim = new Map<string, string>();
  for (const l of persistedLegs ?? []) legIdBySim.set(String(l.sim_output_id), l.id);

  const ticketInserts: any[] = [];
  const addTicket = (kind: string, legs: Candidate[] | null) => {
    if (!legs || !legs.length) return;
    const legIds = legs.map((l) => legIdBySim.get(String(l.row.id))).filter(Boolean) as string[];
    if (legIds.length !== legs.length) return;
    ticketInserts.push({
      run_id: runId, kind, leg_ids: legIds,
      estimated_combined_probability: estimatedCombinedProbability(legs.map((l) => l.diamondProbability)),
      min_leg_probability: Math.min(...legs.map((l) => l.diamondProbability)),
      min_recommendation_score: Math.min(...legs.map((l) => l.score)),
      notes: { formulaVersion: FORMULA_VERSION },
    });
  };
  addTicket("double", doubleTicket as unknown as Candidate[]);
  addTicket("triple", tripleTicket as unknown as Candidate[]);
  if (!tripleTicket) addTicket("higher_upside", higherUpsideTicket as unknown as Candidate[]);
  if (ticketInserts.length) {
    await admin.from("recommendation_tickets").insert(ticketInserts);
  }

  // 12. LIVE supersession — mark previous active LIVE runs for the slate as superseded.
  if (opts.state === "LIVE") {
    const { data: superseded } = await admin
      .from("recommendation_runs")
      .update({ superseded_at: nowIso, superseded_by: runId, status: "superseded" })
      .eq("slate_date", opts.slateDate)
      .eq("state", "LIVE")
      .is("superseded_at", null)
      .neq("id", runId)
      .select("id");
    result.supersededRuns = superseded?.length ?? 0;
  }

  return result;
}

/** Small helper: expected value helpers (re-exported for external use). */
export { americanToImplied, twoSidedNoVig, expectedValue };
