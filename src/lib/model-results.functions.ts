/**
 * Model Results — date-selection helpers.
 *
 * Pure date/discovery server fns so the /calibration-lab page can default to
 * the most recent finalized slate (Chicago game-day) and step through
 * completed days. No simulation, scoring, or probability math here.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAppMember } from "@/integrations/supabase/member-middleware";
import { todayInAppTz } from "@/lib/timezone";

export type ModelResultsDateInfo = {
  date: string;
  scheduled: number;
  final: number;
  pending: number;
  terminal: boolean; // every game is Final/Postponed/Cancelled/Suspended
  hasActuals: boolean;
};

const TERMINAL_STATUSES = new Set([
  "Final",
  "Game Over",
  "Completed Early",
  "Postponed",
  "Cancelled",
  "Canceled",
  "Suspended",
]);

async function fetchDateInfo(
  supabase: ReturnType<typeof requireAppMember> extends never ? never : any,
  date: string,
): Promise<ModelResultsDateInfo> {
  const { data: games } = await supabase
    .from("games")
    .select("id, game_status")
    .eq("date", date);

  const scheduled = games?.length ?? 0;
  let final = 0;
  let terminalCount = 0;
  for (const g of games ?? []) {
    const s = String(g.game_status ?? "");
    if (s === "Final" || s === "Game Over" || s === "Completed Early") final += 1;
    if (TERMINAL_STATUSES.has(s)) terminalCount += 1;
  }

  let hasActuals = false;
  if (scheduled > 0) {
    const ids = (games ?? []).map((g: any) => g.id);
    const { count } = await supabase
      .from("projection_results")
      .select("id", { count: "exact", head: true })
      .in("game_id", ids);
    hasActuals = (count ?? 0) > 0;
  }

  return {
    date,
    scheduled,
    final,
    pending: Math.max(0, scheduled - final),
    terminal: scheduled > 0 && terminalCount === scheduled,
    hasActuals,
  };
}

/**
 * Most recent game date suitable for Model Results review.
 * Preference order:
 *   1. Latest date whose games are all terminal AND has stored actuals.
 *   2. Latest date with any final game.
 *   3. Latest date with scheduled games (so the user still sees status).
 *   4. Chicago today as a last resort.
 */
export const getDefaultModelResultsDate = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .handler(async ({ context }): Promise<{ date: string; info: ModelResultsDateInfo | null }> => {
    const { supabase } = context;
    const today = todayInAppTz();

    const { data: dates } = await supabase
      .from("games")
      .select("date")
      .lte("date", today)
      .order("date", { ascending: false })
      .limit(120);

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const r of dates ?? []) {
      const d = String((r as any).date);
      if (!seen.has(d)) {
        seen.add(d);
        unique.push(d);
      }
    }

    let firstWithFinal: ModelResultsDateInfo | null = null;
    let firstWithGames: ModelResultsDateInfo | null = null;

    for (const d of unique.slice(0, 14)) {
      const info = await fetchDateInfo(supabase, d);
      if (!firstWithGames && info.scheduled > 0) firstWithGames = info;
      if (!firstWithFinal && info.final > 0) firstWithFinal = info;
      if (info.terminal && info.hasActuals) {
        return { date: d, info };
      }
    }

    if (firstWithFinal) return { date: firstWithFinal.date, info: firstWithFinal };
    if (firstWithGames) return { date: firstWithGames.date, info: firstWithGames };
    return { date: today, info: null };
  });

/**
 * Lookup status for a specific date, plus the nearest previous and next dates
 * that have scheduled games — used to enable/disable Prev/Next buttons.
 */
export const getModelResultsDateStatus = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator((data: { date: string }) => {
    if (!data?.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
      throw new Error("date must be YYYY-MM-DD");
    }
    return data;
  })
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      info: ModelResultsDateInfo;
      prevDate: string | null;
      nextDate: string | null;
      latestFinalizedDate: string | null;
    }> => {
      const { supabase } = context;
      const info = await fetchDateInfo(supabase, data.date);

      const { data: prev } = await supabase
        .from("games")
        .select("date")
        .lt("date", data.date)
        .order("date", { ascending: false })
        .limit(1);
      const { data: next } = await supabase
        .from("games")
        .select("date")
        .gt("date", data.date)
        .order("date", { ascending: true })
        .limit(1);

      const today = todayInAppTz();
      const { data: finals } = await supabase
        .from("games")
        .select("date, game_status")
        .lte("date", today)
        .in("game_status", ["Final", "Game Over", "Completed Early"])
        .order("date", { ascending: false })
        .limit(1);

      return {
        info,
        prevDate: prev?.[0] ? String((prev[0] as any).date) : null,
        nextDate: next?.[0] ? String((next[0] as any).date) : null,
        latestFinalizedDate: finals?.[0] ? String((finals[0] as any).date) : null,
      };
    },
  );
