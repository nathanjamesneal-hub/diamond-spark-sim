/**
 * Model Results — date-selection + diagnostic helpers.
 *
 * Strict integrity rules these helpers MUST enforce:
 *   - projection_class = 'official'
 *   - projection_status = 'active'
 *   - sim_snapshot IS NOT NULL  (locked pregame Monte Carlo snapshot)
 *   - never include 'preview' or 'legacy_unverified' rows
 *
 * Defaulting must NEVER silently jump backwards to an older date. If no
 * trusted locked forecasts exist, return yesterday in Chicago with an
 * explicit reason so the UI can render the "no trusted forecasts" empty
 * state instead of pretending a stale legacy date is the latest result.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAppMember } from "@/integrations/supabase/member-middleware";
import { todayInAppTz, shiftIsoDate } from "@/lib/timezone";

export type SnapshotCoverage = {
  eligible: number; // active OFFICIAL projection rows for the slate
  locked: number;   // active OFFICIAL projection rows with sim_snapshot
};

export type ModelResultsDateInfo = {
  date: string;
  scheduled: number;
  final: number;
  pending: number;
  terminal: boolean; // every game is Final/Postponed/Cancelled/Suspended
  hasActuals: boolean;
  actualsGameCount: number;
  snapshotCoverage: SnapshotCoverage;
};

export type DefaultDateReason =
  | "trusted_terminal"   // tier 1: all final + locked snapshots + actuals
  | "trusted_partial"    // tier 2: partial slate but trusted snapshots exist
  | "no_trusted_forecasts_yet"; // tier 3: nothing trusted to grade

export type TrustedDateRange = {
  first_trusted_date: string | null;
  last_graded_date: string | null;
  graded_locked_count: number;
  model_versions: string[];
  excluded_preview_count: number;
  excluded_legacy_count: number;
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
  supabase: any,
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

  let actualsGameCount = 0;
  const coverage: SnapshotCoverage = { eligible: 0, locked: 0 };
  if (scheduled > 0) {
    const ids = (games ?? []).map((g: any) => g.id);

    const { data: actualsRows } = await supabase
      .from("projection_results")
      .select("game_id")
      .in("game_id", ids);
    actualsGameCount = new Set((actualsRows ?? []).map((r: any) => r.game_id)).size;

    const { count: eligibleCount } = await supabase
      .from("projections")
      .select("id", { count: "exact", head: true })
      .in("game_id", ids)
      .eq("projection_status", "active")
      .eq("projection_class", "official");
    coverage.eligible = eligibleCount ?? 0;

    const { count: lockedCount } = await supabase
      .from("projections")
      .select("id", { count: "exact", head: true })
      .in("game_id", ids)
      .eq("projection_status", "active")
      .eq("projection_class", "official")
      .not("sim_snapshot", "is", null);
    coverage.locked = lockedCount ?? 0;
  }

  return {
    date,
    scheduled,
    final,
    pending: Math.max(0, scheduled - final),
    terminal: scheduled > 0 && terminalCount === scheduled,
    hasActuals: actualsGameCount > 0,
    actualsGameCount,
    snapshotCoverage: coverage,
  };
}

async function listRecentSlateDates(
  supabase: any,
  today: string,
  limit: number,
): Promise<string[]> {
  const { data: dates } = await supabase
    .from("games")
    .select("date")
    .lte("date", today)
    .order("date", { ascending: false })
    .limit(limit * 4); // duplicates per game; dedupe below
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const r of dates ?? []) {
    const d = String((r as any).date);
    if (!seen.has(d)) {
      seen.add(d);
      unique.push(d);
      if (unique.length >= limit) break;
    }
  }
  return unique;
}

/**
 * Most recent Chicago game date that we can TRUST for Model Results.
 *
 * Tier 1: terminal slate + actuals + locked snapshots > 0.
 * Tier 2: partial slate + locked snapshots > 0 (still trusted, just incomplete).
 * Tier 3: no trusted data exists yet. Return YESTERDAY (Chicago) with a
 *   `no_trusted_forecasts_yet` reason. We deliberately do NOT silently jump
 *   to an older legacy date — that was the old broken behavior that landed
 *   users on stale "June 24" recaps.
 */
export const getDefaultModelResultsDate = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .handler(async ({ context }): Promise<{
    date: string;
    info: ModelResultsDateInfo | null;
    reason: DefaultDateReason;
  }> => {
    const { supabase } = context;
    const today = todayInAppTz();
    const candidates = await listRecentSlateDates(supabase, today, 30);

    let trustedPartial: { date: string; info: ModelResultsDateInfo } | null = null;
    for (const d of candidates) {
      const info = await fetchDateInfo(supabase, d);
      if (info.snapshotCoverage.locked > 0) {
        if (info.terminal && info.hasActuals) {
          return { date: d, info, reason: "trusted_terminal" };
        }
        if (!trustedPartial) trustedPartial = { date: d, info };
      }
    }
    if (trustedPartial) {
      return { date: trustedPartial.date, info: trustedPartial.info, reason: "trusted_partial" };
    }

    // Tier 3 — no trusted data anywhere. Anchor to yesterday Chicago so the
    // empty state references a meaningful slate, not "today, no games final".
    const yesterday = shiftIsoDate(today, -1);
    const info = await fetchDateInfo(supabase, yesterday);
    return { date: yesterday, info, reason: "no_trusted_forecasts_yet" };
  });

/**
 * Per-date diagnostic counts for the Model page debug surface.
 * Last N Chicago game dates, descending.
 */
export const getModelResultsDiagnostics = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator((data: { days?: number } | undefined) => {
    const days = Math.min(Math.max(Number(data?.days ?? 7), 1), 30);
    return { days };
  })
  .handler(async ({ data, context }): Promise<ModelResultsDateInfo[]> => {
    const { supabase } = context;
    const today = todayInAppTz();
    const dates = await listRecentSlateDates(supabase, today, data.days);
    const rows: ModelResultsDateInfo[] = [];
    for (const d of dates) {
      rows.push(await fetchDateInfo(supabase, d));
    }
    return rows;
  });

/**
 * Coverage summary for the /model header. Reports how much trusted data
 * exists in total and what is intentionally excluded.
 */
export const getTrustedDateRange = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .handler(async ({ context }): Promise<TrustedDateRange> => {
    const { supabase } = context;

    const { data: trustedRows } = await supabase
      .from("projections")
      .select("game_id, model_version")
      .eq("projection_status", "active")
      .eq("projection_class", "official")
      .not("sim_snapshot", "is", null);

    const trustedGameIds = Array.from(
      new Set((trustedRows ?? []).map((r: any) => r.game_id).filter(Boolean)),
    );
    const modelVersions = Array.from(
      new Set((trustedRows ?? []).map((r: any) => String(r.model_version)).filter(Boolean)),
    ).sort();

    let firstDate: string | null = null;
    let lastDate: string | null = null;
    let gradedCount = 0;

    if (trustedGameIds.length > 0) {
      const { data: gameDates } = await supabase
        .from("games")
        .select("id, date")
        .in("id", trustedGameIds);
      const dates = (gameDates ?? []).map((g: any) => String(g.date)).sort();
      firstDate = dates[0] ?? null;

      // last graded = most recent date where trusted rows AND actuals exist
      const { data: actualGameIds } = await supabase
        .from("projection_results")
        .select("game_id")
        .in("game_id", trustedGameIds);
      const actualSet = new Set((actualGameIds ?? []).map((r: any) => r.game_id));
      const gradedDates = (gameDates ?? [])
        .filter((g: any) => actualSet.has(g.id))
        .map((g: any) => String(g.date))
        .sort();
      lastDate = gradedDates[gradedDates.length - 1] ?? null;
      gradedCount = (trustedRows ?? []).filter((r: any) => actualSet.has(r.game_id)).length;
    }

    const { count: previewCount } = await supabase
      .from("projections")
      .select("id", { count: "exact", head: true })
      .eq("projection_class", "preview");
    const { count: legacyCount } = await supabase
      .from("projections")
      .select("id", { count: "exact", head: true })
      .eq("projection_class", "legacy_unverified");

    return {
      first_trusted_date: firstDate,
      last_graded_date: lastDate,
      graded_locked_count: gradedCount,
      model_versions: modelVersions,
      excluded_preview_count: previewCount ?? 0,
      excluded_legacy_count: legacyCount ?? 0,
    };
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
      latestTrustedDate: string | null;
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

      // Latest date that has any trusted locked official projection row.
      const { data: trusted } = await supabase
        .from("projections")
        .select("game_id")
        .eq("projection_status", "active")
        .eq("projection_class", "official")
        .not("sim_snapshot", "is", null)
        .limit(2000);
      let latestTrustedDate: string | null = null;
      const trustedGameIds = Array.from(
        new Set((trusted ?? []).map((r: any) => r.game_id).filter(Boolean)),
      );
      if (trustedGameIds.length > 0) {
        const { data: tg } = await supabase
          .from("games")
          .select("date")
          .in("id", trustedGameIds)
          .lte("date", today)
          .order("date", { ascending: false })
          .limit(1);
        latestTrustedDate = tg?.[0] ? String((tg[0] as any).date) : null;
      }

      return {
        info,
        prevDate: prev?.[0] ? String((prev[0] as any).date) : null,
        nextDate: next?.[0] ? String((next[0] as any).date) : null,
        latestFinalizedDate: finals?.[0] ? String((finals[0] as any).date) : null,
        latestTrustedDate,
      };
    },
  );
