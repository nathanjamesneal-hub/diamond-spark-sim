/**
 * Market-only refresh.
 *
 * Recomputes no-vig implied probability and edge for every open bet on the
 * given slate WITHOUT rerunning the Monte Carlo simulation. The persisted
 * sim distribution (`sim_player_outputs`) is reused; only market side math
 * changes.
 *
 * v1 scope (minimal): we only touch bets whose (market, threshold) pair is
 * already covered by a persisted sim output row. If the sportsbook posts a
 * line the sim distribution does not directly cover, we skip it — recomputing
 * arbitrary thresholds from raw distributions is deferred.
 *
 * Never fabricates prices or lines.
 * Server-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type MarketRefreshResult = {
  runId: string | null;
  slateDate: string;
  startedAt: string;
  finishedAt: string;
  consideredGames: number;
  updatedRows: number;
  unchangedRows: number;
  skippedRows: number;
  perBet: Array<{
    betId: string;
    gamePk: number;
    market: string;
    threshold: number | null;
    americanOdds: number | null;
    impliedProbability: number | null;
    noVigProbability: number | null;
    modelProbability: number | null;
    edge: number | null;
    reason: string;
  }>;
  error?: string;
};

/** Convert American odds → implied probability (raw, includes vig). */
export function americanImplied(odds: number | null | undefined): number | null {
  if (odds == null || !Number.isFinite(odds)) return null;
  if (odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
}

/**
 * Two-sided no-vig probability. When we only have the "over" price we can't
 * strip vig, so we return the raw implied probability and mark it accordingly.
 */
export function noVigTwoSided(overImpl: number | null, underImpl: number | null): number | null {
  if (overImpl == null) return null;
  if (underImpl == null) return overImpl;
  const s = overImpl + underImpl;
  if (s <= 0) return null;
  return overImpl / s;
}

export async function runMarketRefreshForDate(
  supabaseAdmin: SupabaseClient,
  slateDate: string,
): Promise<MarketRefreshResult> {
  const startedAt = new Date().toISOString();
  const result: MarketRefreshResult = {
    runId: null,
    slateDate,
    startedAt,
    finishedAt: startedAt,
    consideredGames: 0,
    updatedRows: 0,
    unchangedRows: 0,
    skippedRows: 0,
    perBet: [],
  };

  // Load the slate's games so we can scope bets by game_pk.
  const { data: games, error: gErr } = await supabaseAdmin
    .from("games")
    .select("id, mlb_game_id")
    .eq("date", slateDate);
  if (gErr) {
    result.error = `games query failed: ${gErr.message}`;
    result.finishedAt = new Date().toISOString();
    return result;
  }
  const gamePks = (games ?? []).map((g: any) => g.mlb_game_id).filter(Boolean) as number[];
  result.consideredGames = gamePks.length;

  if (gamePks.length === 0) {
    result.finishedAt = new Date().toISOString();
    return result;
  }

  const { data: bets, error: bErr } = await supabaseAdmin
    .from("bets")
    .select("id, game_pk, market, selection, line, odds, status")
    .in("game_pk", gamePks)
    .eq("status", "open");
  if (bErr) {
    result.error = `bets query failed: ${bErr.message}`;
    result.finishedAt = new Date().toISOString();
    return result;
  }

  if (!bets || bets.length === 0) {
    // No open bets → still record a market-refresh run row so admins can see the tick.
    const { data: run } = await supabaseAdmin
      .from("market_refresh_runs")
      .insert({
        slate_date: slateDate,
        finished_at: new Date().toISOString(),
        considered_games: gamePks.length,
        updated_rows: 0,
        unchanged_rows: 0,
        skipped_reason: "no open bets",
        details: {},
      })
      .select("id")
      .single();
    result.runId = run?.id ?? null;
    result.finishedAt = new Date().toISOString();
    return result;
  }

  // Pull the latest current sim outputs for these games — scoped to only the
  // (market, threshold) pairs any open bet references, so we don't drag the
  // whole slate into memory.
  const { data: outs } = await supabaseAdmin
    .from("sim_player_outputs")
    .select("game_pk, market, threshold, event_probability, projected_mean, projection_stage, completed_at, run_status")
    .in("game_pk", gamePks)
    .eq("run_status", "current");

  type OutKey = string;
  const key = (gamePk: number, market: string, threshold: number | null): OutKey =>
    `${gamePk}|${market}|${threshold == null ? "_" : Number(threshold)}`;

  const outIndex = new Map<OutKey, any>();
  for (const o of (outs ?? []) as any[]) {
    outIndex.set(key(Number(o.game_pk), String(o.market), o.threshold == null ? null : Number(o.threshold)), o);
  }

  for (const b of bets as any[]) {
    const line = b.line == null ? null : Number(b.line);
    const impl = americanImplied(b.odds ?? null);
    const out = outIndex.get(key(Number(b.game_pk), String(b.market), line));
    if (!out) {
      result.skippedRows += 1;
      result.perBet.push({
        betId: b.id,
        gamePk: Number(b.game_pk),
        market: b.market,
        threshold: line,
        americanOdds: b.odds ?? null,
        impliedProbability: impl,
        noVigProbability: null,
        modelProbability: null,
        edge: null,
        reason: "no persisted sim output for (market, threshold)",
      });
      continue;
    }
    const modelProb = out.event_probability == null ? null : Number(out.event_probability);
    // v1: we only have one side of the price, so no-vig collapses to raw.
    const noVig = noVigTwoSided(impl, null);
    const edge = modelProb != null && noVig != null ? modelProb - noVig : null;
    result.updatedRows += 1;
    result.perBet.push({
      betId: b.id,
      gamePk: Number(b.game_pk),
      market: b.market,
      threshold: line,
      americanOdds: b.odds ?? null,
      impliedProbability: impl,
      noVigProbability: noVig,
      modelProbability: modelProb,
      edge,
      reason: "recomputed from persisted sim distribution (no engine rerun)",
    });
  }

  const finishedAt = new Date().toISOString();
  const { data: run } = await supabaseAdmin
    .from("market_refresh_runs")
    .insert({
      slate_date: slateDate,
      started_at: startedAt,
      finished_at: finishedAt,
      considered_games: gamePks.length,
      updated_rows: result.updatedRows,
      unchanged_rows: result.unchangedRows,
      skipped_reason: result.skippedRows > 0 ? `${result.skippedRows} bets had no matching persisted threshold` : null,
      details: { perBet: result.perBet.slice(0, 200) },
    })
    .select("id")
    .single();
  result.runId = run?.id ?? null;
  result.finishedAt = finishedAt;

  // Update projection_refresh_state.last_market_update_at for touched games.
  const touchedGamePks = new Set(result.perBet.filter((p) => p.modelProbability != null).map((p) => p.gamePk));
  if (touchedGamePks.size > 0) {
    const touchedIds = (games ?? [])
      .filter((g: any) => touchedGamePks.has(Number(g.mlb_game_id)))
      .map((g: any) => g.id);
    if (touchedIds.length) {
      await supabaseAdmin
        .from("projection_refresh_state")
        .update({ last_market_update_at: finishedAt })
        .eq("slate_date", slateDate)
        .in("game_id", touchedIds);
    }
  }

  return result;
}
