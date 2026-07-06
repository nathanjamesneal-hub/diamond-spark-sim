/**
 * Diamond Engine Beta — Data Health signals (admin, read-only).
 *
 * Aggregates truthful "latest successful" timestamps for each production
 * pipeline stage that Engine Beta depends on. No cron jobs are scheduled
 * here; this only READS persisted state and reports Ready / Delayed /
 * Missing / Failed / Not Expected Yet with a concise reason.
 *
 * All slate reasoning uses `todayInAppTz()` (America/Chicago) — same
 * as Pulse and Engine Beta board queries.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { todayInAppTz } from "@/lib/timezone";

export type HealthStatus = "ready" | "delayed" | "missing" | "failed" | "not_expected_yet";

export type HealthCard = {
  key: string;
  label: string;
  status: HealthStatus;
  latestAt: string | null;   // ISO
  ageSeconds: number | null; // seconds since latestAt
  reason: string;            // concise human explanation
  count: number | null;      // relevant count when applicable
  detail: string | null;     // optional extra one-liner (e.g. "9 of 15 games")
};

export type DataHealthPayload = {
  slateDate: string;         // Chicago slate date
  now: string;               // ISO
  cards: HealthCard[];
};

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

function ageSec(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

export const getEngineBetaDataHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string }) => data)
  .handler(async ({ data, context }): Promise<DataHealthPayload> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;
    const slate = data.date ?? todayInAppTz();
    const now = new Date();
    const nowMs = now.getTime();

    // ---- Parallel reads ---------------------------------------------------
    const [
      gamesRes,
      lineupsRes,
      spRes,
      forecastAggRes,
      shadowAggRes,
      recentEventsRes,
      glsRes,
      autoLockRes,
      liveActualsOkRes,
      liveActualsFailRes,
    ] = await Promise.all([
      admin
        .from("games")
        .select("id, game_status, first_pitch_at, updated_at")
        .eq("date", slate),
      admin
        .from("lineups")
        .select("game_id, updated_at, games!inner(date)")
        .eq("games.date", slate)
        .order("updated_at", { ascending: false })
        .limit(500),
      admin
        .from("starting_pitchers")
        .select("game_id, updated_at, games!inner(date)")
        .eq("games.date", slate),
      admin
        .from("forecast_runs")
        .select("game_id, generated_at")
        .eq("slate_date", slate)
        .order("generated_at", { ascending: false }),
      admin
        .from("monte_carlo_form_shadow_runs")
        .select("game_id, created_at")
        .eq("slate_date", slate)
        .order("created_at", { ascending: false }),
      admin
        .from("player_recent_event_rates")
        .select("as_of_date")
        .order("as_of_date", { ascending: false })
        .limit(1),
      admin
        .from("game_lineup_status")
        .select("game_id, status, hitters_set, hitters_expected, updated_at, games!inner(date)")
        .eq("games.date", slate),
      admin
        .from("engine_beta_snapshots")
        .select("id, game_id, lock_mode, lock_reason, created_at")
        .eq("slate_date", slate)
        .not("game_id", "is", null),
      admin
        .from("automation_log")
        .select("started_at, finished_at, status, error, job")
        .eq("status", "ok")
        .eq("slate_date", slate)
        .order("started_at", { ascending: false })
        .limit(1),
      admin
        .from("automation_log")
        .select("started_at, finished_at, status, error, job")
        .eq("status", "failed")
        .eq("slate_date", slate)
        .order("started_at", { ascending: false })
        .limit(1),
      admin
        .from("automation_log")
        .select("started_at, finished_at, status, job")
        .eq("status", "ok")
        .eq("job", "refresh-live-actuals")
        .eq("slate_date", slate)
        .order("started_at", { ascending: false })
        .limit(1),
      admin
        .from("automation_log")
        .select("started_at, error, job")
        .eq("status", "failed")
        .eq("job", "refresh-live-actuals")
        .eq("slate_date", slate)
        .order("started_at", { ascending: false })
        .limit(5),
    ]);

    const games: any[] = gamesRes.data ?? [];
    const nGames = games.length;
    const finalRx = /final|game over|completed/i;
    const startedRx = /live|in progress|final|game over|completed/i;
    const startedGames = games.filter(
      (g) => (g.game_status && startedRx.test(g.game_status)) ||
             (g.first_pitch_at && Date.parse(g.first_pitch_at) <= nowMs),
    );
    const gameIds = new Set(games.map((g) => String(g.id)));

    // ---------------- Schedule readiness ----------------
    const scheduleMaxUpd = games.reduce((m: string | null, g: any) => (!m || g.updated_at > m) ? g.updated_at : m, null as string | null);
    const scheduleCard: HealthCard = (() => {
      if (nGames === 0) {
        return {
          key: "schedule", label: "Schedule",
          status: "missing", latestAt: null, ageSeconds: null,
          reason: "No games scheduled for this slate — check MLB schedule ingest.",
          count: 0, detail: null,
        };
      }
      return {
        key: "schedule", label: "Schedule",
        status: "ready",
        latestAt: scheduleMaxUpd, ageSeconds: ageSec(scheduleMaxUpd, nowMs),
        reason: `${nGames} game${nGames === 1 ? "" : "s"} on the slate.`,
        count: nGames, detail: null,
      };
    })();

    // ---------------- Score / game refresh (live actuals cadence) ----------------
    const liveOk = (liveActualsOkRes.data ?? [])[0]?.started_at ?? null;
    const liveFailRecent = (liveActualsFailRes.data ?? []).find((r: any) => Date.parse(r.started_at) > nowMs - 30 * 60_000);
    const scoreCard: HealthCard = (() => {
      if (nGames === 0) {
        return { key: "score", label: "Score / game refresh", status: "not_expected_yet", latestAt: liveOk, ageSeconds: ageSec(liveOk, nowMs), reason: "No games today — nothing to refresh.", count: 0, detail: null };
      }
      if (liveFailRecent) {
        return { key: "score", label: "Score / game refresh", status: "failed", latestAt: liveOk, ageSeconds: ageSec(liveOk, nowMs), reason: liveFailRecent.error ? `Pipeline job failed: ${String(liveFailRecent.error).slice(0, 100)}` : "Recent refresh-live-actuals job failed.", count: startedGames.length, detail: null };
      }
      if (!liveOk) return { key: "score", label: "Score / game refresh", status: "missing", latestAt: null, ageSeconds: null, reason: "No successful live-actuals run recorded.", count: null, detail: null };
      const age = ageSec(liveOk, nowMs)!;
      const anyLive = startedGames.length > 0;
      if (anyLive && age > 300) return { key: "score", label: "Score / game refresh", status: "delayed", latestAt: liveOk, ageSeconds: age, reason: `Live games in progress but last refresh was ${Math.round(age / 60)}m ago.`, count: startedGames.length, detail: null };
      if (!anyLive && age > 3600) return { key: "score", label: "Score / game refresh", status: "delayed", latestAt: liveOk, ageSeconds: age, reason: `Idle: last refresh ${Math.round(age / 60)}m ago.`, count: 0, detail: null };
      return { key: "score", label: "Score / game refresh", status: "ready", latestAt: liveOk, ageSeconds: age, reason: anyLive ? `${startedGames.length} game${startedGames.length === 1 ? "" : "s"} live / final; scores refreshing.` : "No games live yet; refresher idle.", count: startedGames.length, detail: null };
    })();

    // ---------------- Lineup refresh ----------------
    const lineups: any[] = lineupsRes.data ?? [];
    const lineupLatest = lineups[0]?.updated_at ?? null;
    const gls: any[] = glsRes.data ?? [];
    const confirmedCount = gls.filter((g: any) => g.status === "confirmed" || g.status === "locked").length;
    const lineupCard: HealthCard = (() => {
      if (nGames === 0) return { key: "lineups", label: "Lineups", status: "not_expected_yet", latestAt: null, ageSeconds: null, reason: "No games today.", count: 0, detail: null };
      if (!lineupLatest) return { key: "lineups", label: "Lineups", status: "missing", latestAt: null, ageSeconds: null, reason: "No official lineups posted yet for this slate.", count: 0, detail: `0 of ${nGames} games` };
      const age = ageSec(lineupLatest, nowMs)!;
      const detail = `${confirmedCount} of ${nGames} confirmed / locked`;
      if (confirmedCount === nGames) return { key: "lineups", label: "Lineups", status: "ready", latestAt: lineupLatest, ageSeconds: age, reason: "All lineups confirmed for the slate.", count: confirmedCount, detail };
      if (age > 30 * 60) return { key: "lineups", label: "Lineups", status: "delayed", latestAt: lineupLatest, ageSeconds: age, reason: `Last lineup update ${Math.round(age / 60)}m ago; still awaiting official posts.`, count: confirmedCount, detail };
      return { key: "lineups", label: "Lineups", status: "delayed", latestAt: lineupLatest, ageSeconds: age, reason: "Some games still projected — awaiting official lineups.", count: confirmedCount, detail };
    })();

    // ---------------- Starting pitchers ----------------
    const spRows: any[] = spRes.data ?? [];
    const spLatest = spRows.reduce((m: string | null, r: any) => (!m || (r.updated_at && r.updated_at > m)) ? r.updated_at : m, null as string | null);
    const spGameIds = new Set(spRows.map((r: any) => String(r.game_id)));
    const spCovered = games.filter((g) => spGameIds.has(String(g.id))).length;
    const spCard: HealthCard = (() => {
      if (nGames === 0) return { key: "starters", label: "Starting pitchers", status: "not_expected_yet", latestAt: null, ageSeconds: null, reason: "No games today.", count: 0, detail: null };
      if (spCovered === 0) return { key: "starters", label: "Starting pitchers", status: "missing", latestAt: null, ageSeconds: null, reason: "No probable starters ingested for this slate.", count: 0, detail: `0 of ${nGames * 2} slots` };
      const detail = `${spCovered} of ${nGames * 2} slots`;
      if (spCovered < nGames * 2) return { key: "starters", label: "Starting pitchers", status: "delayed", latestAt: spLatest, ageSeconds: ageSec(spLatest, nowMs), reason: "Awaiting some probable starters.", count: spCovered, detail };
      return { key: "starters", label: "Starting pitchers", status: "ready", latestAt: spLatest, ageSeconds: ageSec(spLatest, nowMs), reason: "All probable starters on file.", count: spCovered, detail };
    })();

    // ---------------- Baseline forecast ----------------
    const forecasts: any[] = forecastAggRes.data ?? [];
    const forecastByGame = new Set(forecasts.map((r: any) => String(r.game_id)));
    const forecastLatest = forecasts[0]?.generated_at ?? null;
    const forecastCovered = games.filter((g) => forecastByGame.has(String(g.id))).length;
    const forecastCard: HealthCard = (() => {
      if (nGames === 0) return { key: "forecast", label: "Baseline forecast", status: "not_expected_yet", latestAt: null, ageSeconds: null, reason: "No games today.", count: 0, detail: null };
      if (forecastCovered === 0) return { key: "forecast", label: "Baseline forecast", status: "missing", latestAt: null, ageSeconds: null, reason: "No baseline Monte Carlo runs persisted for this slate.", count: 0, detail: `0 of ${nGames} games` };
      const age = ageSec(forecastLatest, nowMs)!;
      const detail = `${forecastCovered} of ${nGames} games · latest ${forecastLatest ? Math.round(age / 3600) : 0}h old`;
      if (forecastCovered < nGames) return { key: "forecast", label: "Baseline forecast", status: "delayed", latestAt: forecastLatest, ageSeconds: age, reason: `Forecast missing for ${nGames - forecastCovered} game${nGames - forecastCovered === 1 ? "" : "s"}.`, count: forecastCovered, detail };
      if (age > 72 * 3600) return { key: "forecast", label: "Baseline forecast", status: "failed", latestAt: forecastLatest, ageSeconds: age, reason: `Forecast is ${Math.round(age / 3600)} hours old.`, count: forecastCovered, detail };
      if (age > 24 * 3600) return { key: "forecast", label: "Baseline forecast", status: "delayed", latestAt: forecastLatest, ageSeconds: age, reason: `Forecast is ${Math.round(age / 3600)} hours old.`, count: forecastCovered, detail };
      return { key: "forecast", label: "Baseline forecast", status: "ready", latestAt: forecastLatest, ageSeconds: age, reason: `All games modeled; latest run ${Math.round(age / 60)}m ago.`, count: forecastCovered, detail };
    })();

    // ---------------- Recent-event backfill ----------------
    const recentAsOf = (recentEventsRes.data ?? [])[0]?.as_of_date ?? null;
    const recentCard: HealthCard = (() => {
      if (!recentAsOf) return { key: "recent-events", label: "Recent-event backfill", status: "missing", latestAt: null, ageSeconds: null, reason: "No player_recent_event_rates rows found.", count: null, detail: null };
      // as_of_date is date-only; compare to slate.
      const slateD = Date.parse(slate + "T00:00:00Z");
      const rD = Date.parse(recentAsOf + "T00:00:00Z");
      const dayDiff = Math.round((slateD - rD) / 86400_000);
      if (dayDiff <= 1) return { key: "recent-events", label: "Recent-event backfill", status: "ready", latestAt: recentAsOf, ageSeconds: null, reason: `Backfilled through ${recentAsOf}.`, count: null, detail: null };
      if (dayDiff <= 3) return { key: "recent-events", label: "Recent-event backfill", status: "delayed", latestAt: recentAsOf, ageSeconds: null, reason: `Latest backfill is ${dayDiff} day${dayDiff === 1 ? "" : "s"} behind slate.`, count: null, detail: null };
      return { key: "recent-events", label: "Recent-event backfill", status: "failed", latestAt: recentAsOf, ageSeconds: null, reason: `Backfill is ${dayDiff} days behind slate.`, count: null, detail: null };
    })();

    // ---------------- Form-shadow run ----------------
    const shadows: any[] = shadowAggRes.data ?? [];
    const shadowByGame = new Set(shadows.map((r: any) => String(r.game_id)));
    const shadowLatest = shadows[0]?.created_at ?? null;
    const shadowCovered = games.filter((g) => shadowByGame.has(String(g.id))).length;
    const shadowCard: HealthCard = (() => {
      if (nGames === 0) return { key: "shadow", label: "Form-shadow run", status: "not_expected_yet", latestAt: null, ageSeconds: null, reason: "No games today.", count: 0, detail: null };
      if (forecastCovered === 0) return { key: "shadow", label: "Form-shadow run", status: "not_expected_yet", latestAt: null, ageSeconds: null, reason: "Shadow runs follow baseline forecasts — waiting for baseline.", count: 0, detail: null };
      if (shadowCovered === 0) return { key: "shadow", label: "Form-shadow run", status: "missing", latestAt: null, ageSeconds: null, reason: "No shadow run exists for this slate.", count: 0, detail: null };
      const detail = `${shadowCovered} of ${nGames} games`;
      if (shadowCovered < forecastCovered) return { key: "shadow", label: "Form-shadow run", status: "delayed", latestAt: shadowLatest, ageSeconds: ageSec(shadowLatest, nowMs), reason: `Shadow covers ${shadowCovered} of ${forecastCovered} forecasted games.`, count: shadowCovered, detail };
      return { key: "shadow", label: "Form-shadow run", status: "ready", latestAt: shadowLatest, ageSeconds: ageSec(shadowLatest, nowMs), reason: "Shadow run present for all forecasted games.", count: shadowCovered, detail };
    })();

    // ---------------- Per-game auto-lock ----------------
    const snaps: any[] = autoLockRes.data ?? [];
    const autoLocked = snaps.filter((s: any) => s.lock_mode === "automatic" && !s.lock_reason).length;
    const missed = snaps.filter((s: any) => s.lock_mode === "automatic" && s.lock_reason === "missed_pregame_window").length;
    const manual = snaps.filter((s: any) => s.lock_mode === "manual_game").length;
    const covered = autoLocked + missed + manual; // one snapshot per game max
    const remaining = Math.max(0, nGames - covered);
    const lockCard: HealthCard = (() => {
      if (nGames === 0) return { key: "autolock", label: "Beta auto-lock", status: "not_expected_yet", latestAt: null, ageSeconds: null, reason: "No games to lock.", count: 0, detail: null };
      const anyPregameOpen = games.some((g) => g.first_pitch_at && Date.parse(g.first_pitch_at) > nowMs);
      const detail = `${autoLocked} auto · ${manual} manual · ${missed} missed · ${remaining} pending`;
      if (missed > 0) return { key: "autolock", label: "Beta auto-lock", status: "failed", latestAt: null, ageSeconds: null, reason: `${missed} game${missed === 1 ? "" : "s"} missed the pregame lock window.`, count: covered, detail };
      if (covered === 0 && anyPregameOpen) return { key: "autolock", label: "Beta auto-lock", status: "not_expected_yet", latestAt: null, ageSeconds: null, reason: "Pregame lock window has not opened for any game yet.", count: 0, detail };
      if (covered === 0 && !anyPregameOpen) return { key: "autolock", label: "Beta auto-lock", status: "missing", latestAt: null, ageSeconds: null, reason: "All games have started but no snapshots exist.", count: 0, detail };
      if (remaining > 0) return { key: "autolock", label: "Beta auto-lock", status: "delayed", latestAt: null, ageSeconds: null, reason: `${remaining} game${remaining === 1 ? "" : "s"} still awaiting their lock window.`, count: covered, detail };
      return { key: "autolock", label: "Beta auto-lock", status: "ready", latestAt: null, ageSeconds: null, reason: "All games locked or accounted for.", count: covered, detail };
    })();

    return {
      slateDate: slate,
      now: now.toISOString(),
      cards: [scheduleCard, scoreCard, lineupCard, spCard, forecastCard, recentCard, shadowCard, lockCard],
    };
  });
