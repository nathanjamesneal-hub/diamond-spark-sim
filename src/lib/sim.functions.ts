/**
 * Server function wrapper around the Monte Carlo engine.
 * Pulls lineups + season stats from MLB Stats API, builds BatterProfile /
 * PitcherProfile objects, and runs the engine. Results are cached in-memory
 * per gamePk for ~10 minutes.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAppMember } from "@/integrations/supabase/member-middleware";
import { simulate, type SimResult, type BatterProfile, type PitcherProfile, type TeamSim } from "./sim/engine";
import { toMonteCarloGameEnvironment } from "./sim/environment";
import type { MonteCarloGameEnvironment } from "./game-environment";

const BASE = "https://statsapi.mlb.com/api/v1";

async function mlbFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`MLB ${res.status} ${path}`);
  return (await res.json()) as T;
}

type CacheEntry = {
  at: number;
  data: SimResult;
  meta: SimMeta;
  gameEnvironment: MonteCarloGameEnvironment;
};
const CACHE = new Map<number, CacheEntry>();
const TTL_MS = 10 * 60 * 1000;

export type SimMeta = {
  gamePk: number;
  date: string;
  venue: string;
  venueId: number | null;
  status: string;
  homeName: string;
  homeAbbrev: string;
  awayName: string;
  awayAbbrev: string;
  homeStarter: string;
  awayStarter: string;
  season: number;
  warnings: string[];
};

function currentSeason(): number {
  const d = new Date();
  const month = d.getUTCMonth() + 1;
  return month < 3 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

async function batterProfile(playerId: number, name: string, season: number): Promise<BatterProfile> {
  try {
    const j = await mlbFetch<any>(
      `/people/${playerId}/stats?stats=season&group=hitting&season=${season}`,
    );
    const s = j.stats?.[0]?.splits?.[0]?.stat;
    if (!s || !s.plateAppearances) throw new Error("no PA");
    return {
      id: playerId,
      name,
      pa: s.plateAppearances ?? 0,
      K: s.strikeOuts ?? 0,
      BB: s.baseOnBalls ?? 0,
      HBP: s.hitByPitch ?? 0,
      HR: s.homeRuns ?? 0,
      H_2B: s.doubles ?? 0,
      H_3B: s.triples ?? 0,
      H_1B: Math.max(0, (s.hits ?? 0) - (s.doubles ?? 0) - (s.triples ?? 0) - (s.homeRuns ?? 0)),
      SB: s.stolenBases ?? 0,
    };
  } catch {
    // league-average fallback (~600 PA shape)
    return { id: playerId, name, pa: 600, K: 134, BB: 51, HBP: 7, HR: 18, H_1B: 84, H_2B: 27, H_3B: 2 };
  }
}

async function pitcherProfile(playerId: number, name: string, season: number, isStarter: boolean): Promise<PitcherProfile> {
  try {
    const j = await mlbFetch<any>(
      `/people/${playerId}/stats?stats=season&group=pitching&season=${season}`,
    );
    const s = j.stats?.[0]?.splits?.[0]?.stat;
    if (!s || !s.battersFaced) throw new Error("no BF");
    return {
      id: playerId,
      name,
      bf: s.battersFaced ?? 0,
      K: s.strikeOuts ?? 0,
      BB: s.baseOnBalls ?? 0,
      HBP: s.hitBatsmen ?? 0,
      HR: s.homeRuns ?? 0,
      H_2B: s.doubles ?? 0,
      H_3B: s.triples ?? 0,
      H_1B: Math.max(0, (s.hits ?? 0) - (s.doubles ?? 0) - (s.triples ?? 0) - (s.homeRuns ?? 0)),
      expectedIp: isStarter ? 5.5 : 1.0,
    };
  } catch {
    return isStarter
      ? { id: playerId, name, bf: 600, K: 138, BB: 54, HBP: 6, HR: 19, H_1B: 90, H_2B: 28, H_3B: 2, expectedIp: 5.5 }
      : { id: playerId, name, bf: 250, K: 65, BB: 25, HBP: 3, HR: 7, H_1B: 35, H_2B: 11, H_3B: 1, expectedIp: 1 };
  }
}

async function getGameContext(gamePk: number): Promise<any> {
  // Use schedule with hydrate to get lineups, probables, venue
  return mlbFetch<any>(`/schedule?sportId=1&gamePk=${gamePk}&hydrate=team,linescore,probablePitcher,lineups,venue`);
}

async function getTopHitters(teamId: number, season: number, n = 9): Promise<{ id: number; name: string }[]> {
  try {
    // Use team roster sorted by PA
    const r = await mlbFetch<any>(
      `/teams/${teamId}/roster?rosterType=active`,
    );
    const candidates: { id: number; name: string }[] = (r.roster ?? [])
      .filter((p: any) => p.position?.type !== "Pitcher")
      .map((p: any) => ({ id: p.person.id, name: p.person.fullName }));
    // Fetch PA for each (limited; pick first 14 then sort)
    const top = candidates.slice(0, 14);
    const withPa = await Promise.all(
      top.map(async (c) => {
        try {
          const s = await mlbFetch<any>(`/people/${c.id}/stats?stats=season&group=hitting&season=${season}`);
          const pa = s.stats?.[0]?.splits?.[0]?.stat?.plateAppearances ?? 0;
          return { ...c, pa };
        } catch { return { ...c, pa: 0 }; }
      }),
    );
    withPa.sort((a, b) => b.pa - a.pa);
    return withPa.slice(0, n).map(({ id, name }) => ({ id, name }));
  } catch {
    return [];
  }
}

async function getBullpenAggregate(teamId: number, season: number, starterIds: Set<number>): Promise<PitcherProfile> {
  try {
    const r = await mlbFetch<any>(`/teams/${teamId}/roster?rosterType=active`);
    const relievers = (r.roster ?? [])
      .filter((p: any) => p.position?.type === "Pitcher" && !starterIds.has(p.person.id))
      .slice(0, 8);
    let bf = 0, K = 0, BB = 0, HBP = 0, HR = 0, H = 0, H_2B = 0, H_3B = 0;
    await Promise.all(relievers.map(async (p: any) => {
      try {
        const s = await mlbFetch<any>(`/people/${p.person.id}/stats?stats=season&group=pitching&season=${season}`);
        const st = s.stats?.[0]?.splits?.[0]?.stat;
        if (!st) return;
        bf += st.battersFaced ?? 0;
        K += st.strikeOuts ?? 0;
        BB += st.baseOnBalls ?? 0;
        HBP += st.hitBatsmen ?? 0;
        HR += st.homeRuns ?? 0;
        H += st.hits ?? 0;
        H_2B += st.doubles ?? 0;
        H_3B += st.triples ?? 0;
      } catch {}
    }));
    if (bf < 50) throw new Error("thin bullpen sample");
    return {
      id: 0, name: "Bullpen",
      bf, K, BB, HBP, HR,
      H_1B: Math.max(0, H - H_2B - H_3B - HR),
      H_2B, H_3B,
      expectedIp: 1,
    };
  } catch {
    return { id: 0, name: "Bullpen", bf: 1500, K: 360, BB: 140, HBP: 18, HR: 50, H_1B: 230, H_2B: 70, H_3B: 5, expectedIp: 1 };
  }
}

export async function buildMonteCarloGameEnvironment(
  gamePk: number,
  iterations?: number,
  seed?: number,
): Promise<{ meta: SimMeta; result: SimResult; gameEnvironment: MonteCarloGameEnvironment; venueId: number | null }> {
  const cached = CACHE.get(gamePk);
  if (cached && Date.now() - cached.at < TTL_MS && !iterations && seed === undefined) {
    return { meta: cached.meta, result: cached.data, gameEnvironment: cached.gameEnvironment, venueId: cached.meta.venueId };
  }


    const season = currentSeason();
    const warnings: string[] = [];
    const sched = await getGameContext(gamePk);
    const game = sched.dates?.[0]?.games?.[0];
    if (!game) throw new Error("Game not found");

    const homeTeamId = game.teams.home.team.id;
    const awayTeamId = game.teams.away.team.id;
    const homeStarterId = game.teams.home.probablePitcher?.id;
    const awayStarterId = game.teams.away.probablePitcher?.id;
    const homeStarterName = game.teams.home.probablePitcher?.fullName ?? "TBD";
    const awayStarterName = game.teams.away.probablePitcher?.fullName ?? "TBD";
    if (!homeStarterId) warnings.push("Home starter TBD — using league-average pitcher");
    if (!awayStarterId) warnings.push("Away starter TBD — using league-average pitcher");

    // Lineups: try posted, fall back to top hitters by PA
    const homeLineupIds: number[] = (game.lineups?.homePlayers ?? []).map((p: any) => p.id);
    const awayLineupIds: number[] = (game.lineups?.awayPlayers ?? []).map((p: any) => p.id);

    const homeLineupRaw =
      homeLineupIds.length === 9
        ? (game.lineups.homePlayers as any[]).map((p) => ({ id: p.id, name: p.fullName }))
        : await getTopHitters(homeTeamId, season);
    const awayLineupRaw =
      awayLineupIds.length === 9
        ? (game.lineups.awayPlayers as any[]).map((p) => ({ id: p.id, name: p.fullName }))
        : await getTopHitters(awayTeamId, season);

    if (homeLineupRaw.length < 9) warnings.push("Home lineup not posted — using top hitters by PA");
    if (awayLineupRaw.length < 9) warnings.push("Away lineup not posted — using top hitters by PA");

    // Build profiles
    const [homeLineup, awayLineup, homeStarter, awayStarter] = await Promise.all([
      Promise.all(homeLineupRaw.slice(0, 9).map((p) => batterProfile(p.id, p.name, season))),
      Promise.all(awayLineupRaw.slice(0, 9).map((p) => batterProfile(p.id, p.name, season))),
      homeStarterId
        ? pitcherProfile(homeStarterId, homeStarterName, season, true)
        : Promise.resolve({ id: 0, name: "TBD", bf: 600, K: 138, BB: 54, HBP: 6, HR: 19, H_1B: 90, H_2B: 28, H_3B: 2, expectedIp: 5.5 } as PitcherProfile),
      awayStarterId
        ? pitcherProfile(awayStarterId, awayStarterName, season, true)
        : Promise.resolve({ id: 0, name: "TBD", bf: 600, K: 138, BB: 54, HBP: 6, HR: 19, H_1B: 90, H_2B: 28, H_3B: 2, expectedIp: 5.5 } as PitcherProfile),
    ]);

    // Pad lineups if short
    while (homeLineup.length < 9) homeLineup.push({ id: -homeLineup.length - 1, name: "Bench bat", pa: 400, K: 96, BB: 32, HBP: 4, HR: 10, H_1B: 60, H_2B: 18, H_3B: 1 });
    while (awayLineup.length < 9) awayLineup.push({ id: -awayLineup.length - 1, name: "Bench bat", pa: 400, K: 96, BB: 32, HBP: 4, HR: 10, H_1B: 60, H_2B: 18, H_3B: 1 });

    const [homeBullpen, awayBullpen] = await Promise.all([
      getBullpenAggregate(homeTeamId, season, new Set([homeStarter.id])),
      getBullpenAggregate(awayTeamId, season, new Set([awayStarter.id])),
    ]);

    const homeTeam: TeamSim = {
      name: game.teams.home.team.name,
      abbreviation: game.teams.home.team.abbreviation ?? "",
      lineup: homeLineup,
      starter: homeStarter,
      bullpen: homeBullpen,
    };
    const awayTeam: TeamSim = {
      name: game.teams.away.team.name,
      abbreviation: game.teams.away.team.abbreviation ?? "",
      lineup: awayLineup,
      starter: awayStarter,
      bullpen: awayBullpen,
    };

    const result = simulate({
      home: homeTeam,
      away: awayTeam,
      venueId: game.venue?.id ?? null,
      iterations: iterations ?? 2000,
      seed: seed ?? gamePk,
    });

    const meta: SimMeta = {
      gamePk,
      date: game.gameDate,
      venue: game.venue?.name ?? "",
      venueId: game.venue?.id ?? null,
      status: game.status?.detailedState ?? "Scheduled",
      homeName: homeTeam.name,
      homeAbbrev: homeTeam.abbreviation,
      awayName: awayTeam.name,
      awayAbbrev: awayTeam.abbreviation,
      homeStarter: homeStarter.name,
      awayStarter: awayStarter.name,
      season,
      warnings,
    };
    const gameEnvironment = toMonteCarloGameEnvironment(gamePk, result);

  CACHE.set(gamePk, { at: Date.now(), data: result, meta, gameEnvironment });
  return { meta, result, gameEnvironment, venueId: game.venue?.id ?? null };
}

/**
 * Forecast-lifecycle entrypoint: deterministic seed forces same engine output
 * for the same material inputs. Internal use only — never called from a read
 * path or React Query handler.
 */
export async function buildMonteCarloGameEnvironmentWithSeed(
  gamePk: number,
  seed: number,
): Promise<{ meta: SimMeta; result: SimResult; gameEnvironment: MonteCarloGameEnvironment; venueId: number | null }> {
  CACHE.delete(gamePk);
  return buildMonteCarloGameEnvironment(gamePk, undefined, seed);
}

export const simulateGame = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator((data: { gamePk: number; iterations?: number }) => ({
    ...data,
    iterations: Math.min(Math.max(data.iterations ?? 2000, 1), 10_000),
  }))
  .handler(async ({ data }): Promise<{
    meta: SimMeta;
    result: SimResult;
    gameEnvironment: MonteCarloGameEnvironment;
    venueId: number | null;
  }> => {
    return buildMonteCarloGameEnvironment(data.gamePk, data.iterations);
  });

// ============================================================
// Top 25 Simulation Leaders — strict pass-through aggregator.
// Reshapes outputs from existing functions; no new math.
// ============================================================

import { getDiamondScores } from "./projections.functions";
import type { PlayerStatDist, BatterDist, PitcherDist } from "./sim/engine";

export type SimStat = {
  mean: number | null;
  p50: number | null;
  p90: number | null;
  stdev: number | null; // engine does not expose stdev; always null
  probAtLeast1: number | null;
  probAtLeast2: number | null;
};

export type SimLeaderHitterRow = {
  player_name: string;
  mlb_id: number | null;
  team_abbrev: string;
  opp_abbrev: string;
  game_id: string;
  mlb_game_id: number | null;
  batting_order: number | null;
  lineup_status: "locked" | "verified" | "waiting";
  badge: string;
  diamond_score: number | null;
  confidence: number | null;
  H: SimStat | null;
  HR: SimStat | null;
  RBI: SimStat | null;
  R: SimStat | null;
  TB: SimStat | null;
  SB: SimStat | null;
  K: SimStat | null;
  card_probabilities: {
    hit: number | null;
    total_base: number | null;
    hr: number | null;
    rbi: number | null;
    run: number | null;
    sb: number | null;
  };
};

export type SimLeaderPitcherRow = {
  player_name: string;
  mlb_id: number | null;
  team_abbrev: string;
  opp_abbrev: string;
  game_id: string;
  mlb_game_id: number | null;
  lineup_status: "locked" | "verified" | "waiting" | null;
  badge: string;
  diamond_score: number | null;
  confidence: number | null;
  projected_outs: number | null;
  outs: SimStat | null;
  K: SimStat | null;
  BB: SimStat | null;
  ER: SimStat | null;
  H: SimStat | null;
  win_probability: number | null;
  quality_start_probability: number | null;
  extra_probabilities: Record<string, number | null>;
};

export type SimulationLeadersPayload = {
  date: string;
  generated_at: string;
  game_count: number;
  games_simulated: number;
  hitters: SimLeaderHitterRow[];
  pitchers: SimLeaderPitcherRow[];
  warnings: string[];
};

function reshapeStat(d: PlayerStatDist | undefined | null): SimStat | null {
  if (!d) return null;
  return {
    mean: typeof d.mean === "number" && isFinite(d.mean) ? d.mean : null,
    p50: typeof d.p50 === "number" && isFinite(d.p50) ? d.p50 : null,
    p90: typeof d.p90 === "number" && isFinite(d.p90) ? d.p90 : null,
    stdev: null,
    probAtLeast1:
      typeof d.probAtLeast1 === "number" && isFinite(d.probAtLeast1) ? d.probAtLeast1 : null,
    probAtLeast2:
      typeof d.probAtLeast2 === "number" && isFinite(d.probAtLeast2) ? d.probAtLeast2 : null,
  };
}

export const getSimulationLeaders = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator((data: { date?: string } | undefined) => data ?? {})
  .handler(async ({ data, context }): Promise<SimulationLeadersPayload> => {
    const warnings: string[] = [];
    const scores = await getDiamondScores({ data: data.date ? { date: data.date } : {} } as any) as Awaited<ReturnType<typeof getDiamondScores>>;

    type SnapStat = import("./sim-snapshot").StoredStatDist;
    type DistMap = Record<string, SnapStat | undefined>;

    // ------------------------------------------------------------------
    // Read-side selector: for each card, the SELECTED snapshot must be used
    // intact. Priority within the SAME selected forecast/run:
    //   1) matching forecast_player_projections.distributions
    //      (only valid for OFFICIAL rows with a forecast_run_id)
    //   2) matching projections.sim_snapshot.distributions
    //      (already attached on the card as `distributions`)
    //   3) null / unavailable
    // We NEVER mix an official FPP row from one run with a preview snapshot
    // from a different run.
    // ------------------------------------------------------------------

    const { supabase } = context;

    // Collect official run ids actually selected by the public selector so we
    // only fetch FPP rows that belong to those exact runs.
    const officialRunIds = new Set<string>();
    for (const h of scores.hitters) {
      if (h.forecast_status !== "preview" && h.forecast_run_id) officialRunIds.add(h.forecast_run_id);
    }
    for (const p of scores.pitchers) {
      if (p.forecast_status !== "preview" && p.forecast_run_id) officialRunIds.add(p.forecast_run_id);
    }

    // Map keyed by (forecast_run_id, player_id, role) → distributions
    const fppDistByKey = new Map<string, DistMap>();
    if (officialRunIds.size > 0) {
      const { data: fppRows } = await supabase
        .from("forecast_player_projections")
        .select("player_id, role, distributions, forecast_run_id")
        .in("forecast_run_id", Array.from(officialRunIds));
      for (const r of fppRows ?? []) {
        const role = (r as any).role === "pitcher" ? "pitcher" : "hitter";
        const key = `${(r as any).forecast_run_id}:${(r as any).player_id}:${role}`;
        const dists = ((r as any).distributions ?? {}) as DistMap;
        fppDistByKey.set(key, dists);
      }
    }

    const { reshapeStoredToSimStat } = await import("./sim-snapshot");

    function pickDistMap(
      role: "hitter" | "pitcher",
      card: { player_id: string; forecast_run_id: string | null; forecast_status: string; distributions: any },
    ): { dists: DistMap | null; source: "fpp" | "sim_snapshot" | null } {
      // Official chosen → prefer FPP for the exact run; fall back to attached
      // projections.sim_snapshot.distributions for the SAME selected row.
      if (card.forecast_status !== "preview" && card.forecast_run_id) {
        const fpp = fppDistByKey.get(`${card.forecast_run_id}:${card.player_id}:${role}`);
        if (fpp) return { dists: fpp, source: "fpp" };
      }
      const snap = (card.distributions ?? null) as DistMap | null;
      if (snap && Object.keys(snap).length > 0) return { dists: snap, source: "sim_snapshot" };
      return { dists: null, source: null };
    }

    let hitterMeanCount = 0;
    let pitcherMeanCount = 0;

    const hitters: SimLeaderHitterRow[] = scores.hitters.map((h) => {
      const { dists } = pickDistMap("hitter", h);
      const pick = (k: string): SimStat | null => (dists ? reshapeStoredToSimStat(dists[k]) : null);
      const H = pick("H");
      if (H?.mean != null) hitterMeanCount += 1;
      return {
        player_name: h.player_name,
        mlb_id: h.mlb_id,
        team_abbrev: h.team_abbrev,
        opp_abbrev: h.opp_abbrev,
        game_id: h.game_id,
        mlb_game_id: h.mlb_game_id,
        batting_order: h.batting_order,
        lineup_status: h.lineup_status,
        badge: h.badge,
        diamond_score: h.diamond_score,
        confidence: h.confidence,
        H,
        HR: pick("HR"),
        RBI: pick("RBI"),
        R: pick("R"),
        TB: pick("TB"),
        SB: pick("SB"),
        K: pick("K"),
        card_probabilities: {
          hit: h.hit_probability,
          total_base: h.total_base_probability,
          hr: h.hr_probability,
          rbi: h.rbi_probability,
          run: h.run_probability,
          sb: h.sb_probability,
        },
      };
    });

    const pitchers: SimLeaderPitcherRow[] = scores.pitchers.map((p) => {
      const { dists } = pickDistMap("pitcher", p);
      // Alias-safe pitcher outs: OUTS or outs.
      const pick = (k: string): SimStat | null => {
        if (!dists) return null;
        return reshapeStoredToSimStat(dists[k] ?? dists[k.toLowerCase()] ?? dists[k.toUpperCase()]);
      };
      const K = pick("K");
      if (K?.mean != null) pitcherMeanCount += 1;
      return {
        player_name: p.player_name,
        mlb_id: p.mlb_id,
        team_abbrev: p.team_abbrev,
        opp_abbrev: p.opp_abbrev,
        game_id: p.game_id,
        mlb_game_id: p.mlb_game_id,
        lineup_status: null,
        badge: p.badge,
        diamond_score: p.diamond_score,
        confidence: p.confidence,
        projected_outs: p.projected_outs,
        outs: pick("outs"),
        K,
        BB: pick("BB"),
        ER: pick("ER"),
        H: pick("H"),
        win_probability: p.pitcher_win_probability,
        quality_start_probability: p.quality_start_probability,
        extra_probabilities: {},
      };
    });

    if (hitters.length === 0 && pitchers.length === 0) {
      warnings.push("No public forecast rows available for this date.");
    } else if (hitterMeanCount === 0 && pitcherMeanCount === 0) {
      warnings.push("No persisted Monte Carlo means available in selected snapshots.");
    }

    console.info(
      `[getSimulationLeaders] date=${scores.date} hitters=${hitters.length} (mean=${hitterMeanCount}) pitchers=${pitchers.length} (mean=${pitcherMeanCount}) officialRuns=${officialRunIds.size}`,
    );

    return {
      date: scores.date,
      generated_at: new Date().toISOString(),
      game_count: scores.games.length,
      games_simulated: 0,
      hitters,
      pitchers,
      warnings,
    };
  });

