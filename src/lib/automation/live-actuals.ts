/**
 * Live actuals worker.
 *
 * Box-score actuals are read live from the MLB Stats API by the client via
 * `getActualsForDate` (see `src/lib/actuals.functions.ts`) — we do not
 * persist a per-player actuals table today. This worker therefore has one
 * job: keep `public.games.game_status` in sync with the MLB schedule so
 * the orchestrator's first-pitch cutoff sees the correct state on the next
 * 2-minute tick.
 *
 * Read-only with respect to forecasts: never touches `forecast_runs`,
 * `forecast_player_projections`, `projections`, or `sim_snapshot`.
 * Server-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { todayInAppTz } from "@/lib/timezone";

import { finishAutomationLog, logAutomation } from "./log";

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

export type LiveActualsResult = {
  ok: boolean;
  date: string;
  scanned: number;
  statusUpdates: number;
  liveGames: number;
  finalGames: number;
  error?: string;
};

async function mlbJson<T>(path: string): Promise<T> {
  const res = await fetch(`${MLB_BASE}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`MLB ${res.status} ${path}`);
  return (await res.json()) as T;
}

export async function refreshLiveActuals(
  supabaseAdmin: SupabaseClient,
  opts?: { date?: string },
): Promise<LiveActualsResult> {
  const startedAt = new Date();
  const date = opts?.date ?? todayInAppTz();

  const logId = await logAutomation(supabaseAdmin, {
    job: "refresh-live-actuals",
    status: "started",
    slate_date: date,
    started_at: startedAt.toISOString(),
  });

  const result: LiveActualsResult = {
    ok: true,
    date,
    scanned: 0,
    statusUpdates: 0,
    liveGames: 0,
    finalGames: 0,
  };

  try {
    const sched = await mlbJson<any>(`/schedule?sportId=1&date=${date}`);
    type G = { gamePk: number; detailed: string; abstract: string };
    const games: G[] = [];
    for (const d of sched.dates ?? []) {
      for (const g of d.games ?? []) {
        games.push({
          gamePk: g.gamePk,
          detailed: g.status?.detailedState ?? "",
          abstract: g.status?.abstractGameState ?? "",
        });
      }
    }
    result.scanned = games.length;

    if (games.length) {
      const pks = games.map((g) => g.gamePk);
      const { data: rows } = await supabaseAdmin
        .from("games")
        .select("id, mlb_game_id, game_status")
        .in("mlb_game_id", pks);

      const byPk = new Map<number, any>(
        (rows ?? []).map((r: any) => [Number(r.mlb_game_id), r]),
      );

      for (const g of games) {
        if (g.abstract === "Live") result.liveGames += 1;
        else if (g.abstract === "Final") result.finalGames += 1;

        const existing = byPk.get(g.gamePk);
        if (!existing) continue;
        if ((existing.game_status ?? "") === g.detailed) continue;

        const { error: upErr } = await supabaseAdmin
          .from("games")
          .update({ game_status: g.detailed })
          .eq("id", existing.id);
        if (!upErr) result.statusUpdates += 1;
      }
    }
  } catch (e: any) {
    result.ok = false;
    result.error = e?.message ?? String(e);
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  await finishAutomationLog(supabaseAdmin, logId, {
    status: !result.ok ? "failed" : result.statusUpdates > 0 ? "ok" : "skipped",
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
    details: {
      scanned: result.scanned,
      statusUpdates: result.statusUpdates,
      liveGames: result.liveGames,
      finalGames: result.finalGames,
    },
    error: result.error ?? null,
  });

  return result;
}
