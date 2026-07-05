import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { todayInAppTz } from "@/lib/timezone";
import type { RecentEventCounts, FormRole } from "./adjustment";

const MLB = "https://statsapi.mlb.com/api/v1";
const SOURCE = "MLB Stats API final game feed + boxscore";

type EventKey = "K" | "BB" | "HBP" | "HR" | "H_1B" | "H_2B" | "H_3B";

type GameEventRow = {
  game_pk: number;
  game_id: string | null;
  game_date: string;
  player_id: string | null;
  mlb_id: number;
  role: FormRole;
  pa: number | null;
  bf: number | null;
  outs: number | null;
  k: number | null;
  bb: number | null;
  hbp: number | null;
  hr: number | null;
  h_1b: number | null;
  h_2b: number | null;
  h_3b: number | null;
  source: string;
  source_fetched_at: string;
};

type MutableCounts = {
  mlbId: number;
  name: string;
  position: string | null;
  role: FormRole;
  pa: number | null;
  bf: number | null;
  outs: number | null;
  K: number | null;
  BB: number | null;
  HBP: number | null;
  HR: number | null;
  H_1B: number | null;
  H_2B: number | null;
  H_3B: number | null;
};

export type RecentEventRefreshResult = {
  ok: boolean;
  asOfDate: string;
  windowDays: number;
  finalGames: number;
  gameEventRows: number;
  rollupRows: number;
  source: string;
  pitcherHitTypesSourced: boolean;
  error?: string;
};

async function mlb<T>(path: string): Promise<T> {
  const res = await fetch(`${MLB}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`MLB ${res.status}: ${path}`);
  return (await res.json()) as T;
}

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function recentWindowRange(asOfDate: string, windowDays: number): { startDate: string; endDate: string } {
  const days = Math.max(1, Math.floor(windowDays));
  return { startDate: addDays(asOfDate, -(days - 1)), endDate: asOfDate };
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parseInningsToOuts(ip: unknown): number {
  if (ip == null) return 0;
  const [wholeRaw, fracRaw = "0"] = String(ip).split(".");
  const whole = Number(wholeRaw) || 0;
  const frac = Number(fracRaw) || 0;
  return whole * 3 + (frac === 1 ? 1 : frac === 2 ? 2 : 0);
}

function hitTypeFromEvent(eventType: string | null | undefined): EventKey | null {
  switch ((eventType ?? "").toLowerCase()) {
    case "single":
      return "H_1B";
    case "double":
    case "ground_rule_double":
      return "H_2B";
    case "triple":
      return "H_3B";
    case "home_run":
      return "HR";
    default:
      return null;
  }
}

function finalGame(game: any): boolean {
  const abstract = String(game?.status?.abstractGameState ?? "").toLowerCase();
  const detailed = String(game?.status?.detailedState ?? "").toLowerCase();
  return abstract === "final" || ["final", "game over", "completed early"].includes(detailed);
}

export function aggregateRowsForWindow(
  rows: GameEventRow[],
  asOfDate: string,
  windowDays: number,
): GameEventRow[] {
  const byKey = new Map<string, GameEventRow>();
  const sourceFetchedAt = rows.reduce<string | null>((latest, row) => {
    if (!latest || row.source_fetched_at > latest) return row.source_fetched_at;
    return latest;
  }, null) ?? new Date().toISOString();

  for (const row of rows) {
    const key = `${row.mlb_id}:${row.role}`;
    const acc = byKey.get(key) ?? {
      game_pk: 0,
      game_id: null,
      game_date: asOfDate,
      player_id: row.player_id,
      mlb_id: row.mlb_id,
      role: row.role,
      pa: null,
      bf: null,
      outs: null,
      k: null,
      bb: null,
      hbp: null,
      hr: null,
      h_1b: null,
      h_2b: null,
      h_3b: null,
      source: SOURCE,
      source_fetched_at: sourceFetchedAt,
    };
    acc.player_id = acc.player_id ?? row.player_id;
    for (const keyName of ["pa", "bf", "outs", "k", "bb", "hbp", "hr", "h_1b", "h_2b", "h_3b"] as const) {
      const value = row[keyName];
      if (value == null) continue;
      acc[keyName] = (acc[keyName] ?? 0) + value;
    }
    byKey.set(key, acc);
  }

  return Array.from(byKey.values()).map((row) => ({
    ...row,
    game_date: asOfDate,
    source: `${SOURCE}; trailing ${windowDays} days`,
    source_fetched_at: sourceFetchedAt,
  }));
}

async function upsertPlayers(admin: any, counts: MutableCounts[]): Promise<Map<number, string>> {
  const byMlb = new Map<number, MutableCounts>();
  for (const count of counts) byMlb.set(count.mlbId, count);
  const players = Array.from(byMlb.values()).map((p) => ({
    mlb_id: p.mlbId,
    name: p.name || `MLB ${p.mlbId}`,
    position: p.position,
    active: true,
  }));
  if (players.length) {
    await admin.from("players").upsert(players, { onConflict: "mlb_id" });
  }
  const ids = players.map((p) => p.mlb_id);
  const { data } = ids.length
    ? await admin.from("players").select("id, mlb_id").in("mlb_id", ids)
    : { data: [] };
  return new Map((data ?? []).map((p: any) => [Number(p.mlb_id), String(p.id)]));
}

async function extractCompletedGameRows(admin: any, game: any, dbGameByPk: Map<number, any>): Promise<GameEventRow[]> {
  const gamePk = Number(game.gamePk);
  const gameDate = String(game.gameDate ?? "").slice(0, 10);
  const fetchedAt = new Date().toISOString();
  const [feed, box] = await Promise.all([
    mlb<any>(`/game/${gamePk}/feed/live`),
    mlb<any>(`/game/${gamePk}/boxscore`),
  ]);
  if (!finalGame(feed?.gameData?.status ? { status: feed.gameData.status } : game)) return [];

  const hitters = new Map<number, MutableCounts>();
  const pitchers = new Map<number, MutableCounts>();

  for (const side of ["home", "away"] as const) {
    const players = box?.teams?.[side]?.players ?? {};
    for (const key of Object.keys(players)) {
      const p = players[key];
      const mlbId = Number(p?.person?.id);
      if (!mlbId) continue;
      const name = p?.person?.fullName ?? `MLB ${mlbId}`;
      const position = p?.position?.abbreviation ?? null;
      const bat = p?.stats?.batting;
      if (bat && bat.plateAppearances != null) {
        hitters.set(mlbId, {
          mlbId,
          name,
          position,
          role: "hitter",
          pa: num(bat.plateAppearances),
          bf: null,
          outs: null,
          K: num(bat.strikeOuts),
          BB: num(bat.baseOnBalls),
          HBP: num(bat.hitByPitch),
          HR: num(bat.homeRuns),
          H_1B: Math.max(0, num(bat.hits) - num(bat.doubles) - num(bat.triples) - num(bat.homeRuns)),
          H_2B: num(bat.doubles),
          H_3B: num(bat.triples),
        });
      }

      const pit = p?.stats?.pitching;
      if (pit && (pit.battersFaced != null || pit.inningsPitched != null)) {
        pitchers.set(mlbId, {
          mlbId,
          name,
          position,
          role: "pitcher",
          pa: null,
          bf: pit.battersFaced != null ? num(pit.battersFaced) : null,
          outs: parseInningsToOuts(pit.inningsPitched),
          K: num(pit.strikeOuts),
          BB: num(pit.baseOnBalls),
          HBP: num(pit.hitBatsmen),
          HR: num(pit.homeRuns),
          H_1B: 0,
          H_2B: 0,
          H_3B: 0,
        });
      }
    }
  }

  let pitcherHitTypesSourced = false;
  for (const play of feed?.liveData?.plays?.allPlays ?? []) {
    const pitcherId = Number(play?.matchup?.pitcher?.id);
    if (!pitcherId || !pitchers.has(pitcherId)) continue;
    const event = hitTypeFromEvent(play?.result?.eventType);
    if (!event) continue;
    pitcherHitTypesSourced = true;
    const p = pitchers.get(pitcherId)!;
    p[event] = (p[event] ?? 0) + 1;
  }
  if (!pitcherHitTypesSourced) {
    for (const p of pitchers.values()) {
      p.H_1B = null;
      p.H_2B = null;
      p.H_3B = null;
    }
  }

  const playerIds = await upsertPlayers(admin, [...hitters.values(), ...pitchers.values()]);
  const dbGame = dbGameByPk.get(gamePk);
  return [...hitters.values(), ...pitchers.values()].map((p) => ({
    game_pk: gamePk,
    game_id: dbGame?.id ?? null,
    game_date: gameDate,
    player_id: playerIds.get(p.mlbId) ?? null,
    mlb_id: p.mlbId,
    role: p.role,
    pa: p.pa,
    bf: p.bf,
    outs: p.outs,
    k: p.K,
    bb: p.BB,
    hbp: p.HBP,
    hr: p.HR,
    h_1b: p.H_1B,
    h_2b: p.H_2B,
    h_3b: p.H_3B,
    source: SOURCE,
    source_fetched_at: fetchedAt,
  }));
}

export async function refreshRecentEventRatesForDate(
  admin: any,
  asOfDate: string,
  windowDays = 14,
): Promise<RecentEventRefreshResult> {
  const { startDate, endDate } = recentWindowRange(asOfDate, windowDays);
  const schedule = await mlb<any>(`/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}`);
  const games = (schedule?.dates ?? []).flatMap((d: any) => d.games ?? []).filter(finalGame);
  const gamePks = games.map((g: any) => Number(g.gamePk)).filter(Boolean);

  const { data: dbGames } = gamePks.length
    ? await admin.from("games").select("id, mlb_game_id").in("mlb_game_id", gamePks)
    : { data: [] };
  const dbGameByPk = new Map<number, any>((dbGames ?? []).map((g: any) => [Number(g.mlb_game_id), g]));

  let gameEventRows = 0;
  let pitcherHitTypesSourced = true;
  for (const game of games) {
    const rows = await extractCompletedGameRows(admin, game, dbGameByPk);
    if (rows.some((r) => r.role === "pitcher" && (r.h_1b == null || r.h_2b == null || r.h_3b == null))) {
      pitcherHitTypesSourced = false;
    }
    if (rows.length) {
      const { error } = await admin
        .from("player_recent_game_event_counts")
        .upsert(rows, { onConflict: "game_pk,mlb_id,role" });
      if (error) throw new Error(error.message);
      gameEventRows += rows.length;
    }
  }

  const { data: cachedRows, error: readError } = await admin
    .from("player_recent_game_event_counts")
    .select("*")
    .gte("game_date", startDate)
    .lte("game_date", endDate);
  if (readError) throw new Error(readError.message);

  const rollups = aggregateRowsForWindow((cachedRows ?? []) as GameEventRow[], asOfDate, windowDays)
    .map((row) => ({
      as_of_date: asOfDate,
      window_days: windowDays,
      player_id: row.player_id,
      mlb_id: row.mlb_id,
      role: row.role,
      pa: row.pa,
      bf: row.bf,
      outs: row.outs,
      k: row.k,
      bb: row.bb,
      hbp: row.hbp,
      hr: row.hr,
      h_1b: row.h_1b,
      h_2b: row.h_2b,
      h_3b: row.h_3b,
      source: row.source,
      source_fetched_at: row.source_fetched_at,
    }));

  if (rollups.length) {
    const { error } = await admin
      .from("player_recent_event_rates")
      .upsert(rollups, { onConflict: "as_of_date,window_days,mlb_id,role" });
    if (error) throw new Error(error.message);
  }

  return {
    ok: true,
    asOfDate,
    windowDays,
    finalGames: games.length,
    gameEventRows,
    rollupRows: rollups.length,
    source: SOURCE,
    pitcherHitTypesSourced,
  };
}

export async function readRecentEventCounts(
  admin: any,
  asOfDate: string,
  windowDays: number,
  mlbIds: number[],
): Promise<Map<string, RecentEventCounts>> {
  const ids = Array.from(new Set(mlbIds.filter((id) => Number.isFinite(id))));
  if (!ids.length) return new Map();
  const { data, error } = await admin
    .from("player_recent_event_rates")
    .select("*")
    .eq("as_of_date", asOfDate)
    .eq("window_days", windowDays)
    .in("mlb_id", ids);
  if (error) throw new Error(error.message);
  const out = new Map<string, RecentEventCounts>();
  for (const row of data ?? []) {
    out.set(`${row.mlb_id}:${row.role}`, {
      role: row.role,
      mlb_id: Number(row.mlb_id),
      pa: row.pa == null ? null : Number(row.pa),
      bf: row.bf == null ? null : Number(row.bf),
      outs: row.outs == null ? null : Number(row.outs),
      K: row.k == null ? null : Number(row.k),
      BB: row.bb == null ? null : Number(row.bb),
      HBP: row.hbp == null ? null : Number(row.hbp),
      HR: row.hr == null ? null : Number(row.hr),
      H_1B: row.h_1b == null ? null : Number(row.h_1b),
      H_2B: row.h_2b == null ? null : Number(row.h_2b),
      H_3B: row.h_3b == null ? null : Number(row.h_3b),
      source: row.source ?? null,
      source_fetched_at: row.source_fetched_at ?? null,
    });
  }
  return out;
}

export const refreshRecentEventRates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { asOfDate?: string; windowDays?: number } | undefined) => data ?? {})
  .handler(async ({ data, context }): Promise<RecentEventRefreshResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    try {
      return await refreshRecentEventRatesForDate(
        supabaseAdmin as any,
        data.asOfDate ?? todayInAppTz(),
        data.windowDays ?? 14,
      );
    } catch (e: any) {
      return {
        ok: false,
        asOfDate: data.asOfDate ?? todayInAppTz(),
        windowDays: data.windowDays ?? 14,
        finalGames: 0,
        gameEventRows: 0,
        rollupRows: 0,
        source: SOURCE,
        pitcherHitTypesSourced: false,
        error: e?.message ?? String(e),
      };
    }
  });
