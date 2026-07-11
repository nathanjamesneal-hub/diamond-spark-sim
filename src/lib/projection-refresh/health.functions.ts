/**
 * Admin server functions for the Projection Refresh Health panel and the
 * "run refresh audit" button. Same server path the scheduler uses — never a
 * separate code path.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type RefreshHealth = {
  slateDate: string;
  scheduler: {
    lastRunAt: string | null;
    lastStatus: string | null;
    lastDurationMs: number | null;
  };
  counters: {
    gamesTracked: number;
    early: number;
    updated: number;
    lineup_confirmed: number;
    final_pregame: number;
    awaiting_probable_pitchers: number;
    awaiting_confirmed_lineup: number;
    game_started: number;
    postponed: number;
    inputs_unchanged: number;
    stale_jobs: number;
    failed_jobs: number;
  };
  marketRefresh: {
    lastRunAt: string | null;
    lastConsideredGames: number | null;
    lastUpdatedRows: number | null;
    lastSkippedReason: string | null;
  };
  perGame: Array<{
    gameId: string;
    gamePk: number | null;
    firstPitchAt: string | null;
    projectionStage: string | null;
    lifecycleStatus: string;
    pitcherStatus: string | null;
    lineupStatus: string | null;
    inputsHash: string | null;
    lastModelUpdateAt: string | null;
    lastMarketUpdateAt: string | null;
    waitingReason: string | null;
    nextAction: string | null;
    changeReason: string | null;
  }>;
};

export const getRefreshHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { date?: string }) => input)
  .handler(async ({ data, context }): Promise<RefreshHealth> => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { todayInAppTz } = await import("@/lib/timezone");
    const slateDate = data.date ?? todayInAppTz();

    const { data: stateRows } = await supabase
      .from("projection_refresh_state")
      .select(
        "game_id, game_pk, scheduled_first_pitch_at, current_projection_stage, game_lifecycle_status, latest_inputs_hash, pitcher_status, lineup_status, last_model_update_at, last_market_update_at, waiting_reason, next_action, change_reason",
      )
      .eq("slate_date", slateDate)
      .order("scheduled_first_pitch_at", { ascending: true });

    const { data: lastRun } = await supabase
      .from("automation_log")
      .select("finished_at, status, duration_ms")
      .eq("job", "orchestrate-slate")
      .eq("slate_date", slateDate)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: lastMarket } = await supabase
      .from("market_refresh_runs")
      .select("finished_at, considered_games, updated_rows, skipped_reason")
      .eq("slate_date", slateDate)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { count: staleCount } = await supabase
      .from("sim_jobs")
      .select("id", { head: true, count: "exact" })
      .eq("slate_date", slateDate)
      .eq("status", "stale");
    const { count: failedCount } = await supabase
      .from("sim_jobs")
      .select("id", { head: true, count: "exact" })
      .eq("slate_date", slateDate)
      .eq("status", "failed");

    const counters = {
      gamesTracked: stateRows?.length ?? 0,
      early: 0,
      updated: 0,
      lineup_confirmed: 0,
      final_pregame: 0,
      awaiting_probable_pitchers: 0,
      awaiting_confirmed_lineup: 0,
      game_started: 0,
      postponed: 0,
      inputs_unchanged: 0,
      stale_jobs: staleCount ?? 0,
      failed_jobs: failedCount ?? 0,
    };
    for (const s of stateRows ?? []) {
      const stage = (s as any).current_projection_stage as keyof typeof counters | null;
      if (stage && stage in counters) counters[stage] += 1;
      const lc = (s as any).game_lifecycle_status as keyof typeof counters;
      if (lc && lc in counters) counters[lc] += 1;
    }

    return {
      slateDate,
      scheduler: {
        lastRunAt: (lastRun as any)?.finished_at ?? null,
        lastStatus: (lastRun as any)?.status ?? null,
        lastDurationMs: (lastRun as any)?.duration_ms ?? null,
      },
      counters,
      marketRefresh: {
        lastRunAt: (lastMarket as any)?.finished_at ?? null,
        lastConsideredGames: (lastMarket as any)?.considered_games ?? null,
        lastUpdatedRows: (lastMarket as any)?.updated_rows ?? null,
        lastSkippedReason: (lastMarket as any)?.skipped_reason ?? null,
      },
      perGame: (stateRows ?? []).map((s: any) => ({
        gameId: s.game_id,
        gamePk: s.game_pk,
        firstPitchAt: s.scheduled_first_pitch_at,
        projectionStage: s.current_projection_stage,
        lifecycleStatus: s.game_lifecycle_status,
        pitcherStatus: s.pitcher_status,
        lineupStatus: s.lineup_status,
        inputsHash: s.latest_inputs_hash,
        lastModelUpdateAt: s.last_model_update_at,
        lastMarketUpdateAt: s.last_market_update_at,
        waitingReason: s.waiting_reason,
        nextAction: s.next_action,
        changeReason: s.change_reason,
      })),
    };
  });

/** Manual "Run refresh audit" — hits the SAME planner path pg_cron uses. */
export const runProjectionRefreshNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { date?: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runProjectionRefreshPlanner } = await import("./planner.server");
    const { runMarketRefreshForDate } = await import("./market.server");
    const { todayInAppTz } = await import("@/lib/timezone");
    const slateDate = data.date ?? todayInAppTz();
    const plan = await runProjectionRefreshPlanner(supabaseAdmin as any, slateDate);
    const market = await runMarketRefreshForDate(supabaseAdmin as any, slateDate);
    return { plan, market };
  });
