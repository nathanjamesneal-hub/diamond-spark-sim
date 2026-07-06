/**
 * Game Hub — single-game detail from MLB Stats API.
 *
 * Combines /schedule (lite metadata + probable pitchers + linescore) with
 * /game/{pk}/feed/live (batting orders, current line, box-score). Returns a
 * plain DTO shaped for the Game Hub UI. No projections, no edges, no odds.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAppMember } from "@/integrations/supabase/member-middleware";

const MLB = "https://statsapi.mlb.com/api/v1";
const MLB11 = "https://statsapi.mlb.com/api/v1.1";

async function mlb<T>(path: string, base = MLB): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`MLB ${res.status}: ${path}`);
  return (await res.json()) as T;
}

export type GameHubBatter = {
  mlbId: number;
  name: string;
  position: string;
  battingOrder: number | null; // 1..9
  battingLine: string | null;  // "1-3, 1 HR, 2 RBI" while game live/final
};

export type GameHubPitcher = {
  mlbId: number;
  name: string;
  isProbable: boolean;
  isStarter: boolean;
  role: "starter" | "reliever" | "probable";
  pitchingLine: string | null; // "5.2 IP, 4 H, 1 ER, 2 BB, 7 K"
};

export type GameHubTeamSide = {
  teamId: number | null;
  name: string;
  abbreviation: string;
  score: number | null;
  record: string | null;
  probableStarter: { mlbId: number | null; name: string | null };
  battingOrder: GameHubBatter[];
  pitchers: GameHubPitcher[];
  lineupState: "confirmed" | "projected" | "not_posted";
};

export type GameHubPayload = {
  gamePk: number;
  status: string;               // "Scheduled" | "In Progress" | "Final" | ...
  isLive: boolean;
  isFinal: boolean;
  isScheduled: boolean;
  startTimeUtc: string;
  detailedState: string | null;
  venue: string | null;
  inning: number | null;
  inningHalf: "Top" | "Bottom" | null;
  currentBatter: string | null;
  currentPitcher: string | null;
  lastPlay: string | null;
  away: GameHubTeamSide;
  home: GameHubTeamSide;
  fetchedAt: string;
};

function battingSummary(stat: any): string | null {
  if (!stat) return null;
  const ab = Number(stat.atBats ?? 0);
  const h = Number(stat.hits ?? 0);
  const hr = Number(stat.homeRuns ?? 0);
  const rbi = Number(stat.rbi ?? 0);
  const r = Number(stat.runs ?? 0);
  const bb = Number(stat.baseOnBalls ?? 0);
  const k = Number(stat.strikeOuts ?? 0);
  if (ab === 0 && h === 0 && rbi === 0 && hr === 0 && r === 0 && bb === 0 && k === 0) return null;
  const extras = [
    hr > 0 ? `${hr} HR` : null,
    rbi > 0 ? `${rbi} RBI` : null,
    r > 0 ? `${r} R` : null,
    bb > 0 ? `${bb} BB` : null,
    k > 0 ? `${k} K` : null,
  ].filter(Boolean);
  return `${h}-${ab}${extras.length ? `, ${extras.join(", ")}` : ""}`;
}

function pitchingSummary(stat: any): string | null {
  if (!stat) return null;
  const ip = stat.inningsPitched;
  const h = Number(stat.hits ?? 0);
  const er = Number(stat.earnedRuns ?? 0);
  const bb = Number(stat.baseOnBalls ?? 0);
  const k = Number(stat.strikeOuts ?? 0);
  if (!ip && h === 0 && er === 0 && bb === 0 && k === 0) return null;
  return `${ip ?? "0.0"} IP, ${h} H, ${er} ER, ${bb} BB, ${k} K`;
}

function inferLineupState(battingOrder: GameHubBatter[], isLive: boolean, isFinal: boolean): "confirmed" | "projected" | "not_posted" {
  if (!battingOrder.length) return "not_posted";
  if (isLive || isFinal) return "confirmed";
  // Pregame: full batting order posted counts as confirmed
  if (battingOrder.length >= 9) return "confirmed";
  return "projected";
}

function pickTeamSide(side: "home" | "away", schedGame: any, live: any): GameHubTeamSide {
  const team = schedGame?.teams?.[side]?.team ?? {};
  const teamMeta = schedGame?.teams?.[side] ?? {};
  const box = live?.liveData?.boxscore?.teams?.[side] ?? {};
  const players: Record<string, any> = box.players ?? {};
  const battingOrderIds: number[] = box.battingOrder ?? [];
  const battingOrder: GameHubBatter[] = battingOrderIds.map((pid: number, idx: number) => {
    const p = players[`ID${pid}`] ?? {};
    return {
      mlbId: pid,
      name: p.person?.fullName ?? "—",
      position: p.position?.abbreviation ?? "—",
      battingOrder: idx + 1,
      battingLine: battingSummary(p.stats?.batting),
    };
  });
  const pitcherIds: number[] = box.pitchers ?? [];
  const pitchers: GameHubPitcher[] = pitcherIds.map((pid: number, idx: number) => {
    const p = players[`ID${pid}`] ?? {};
    return {
      mlbId: pid,
      name: p.person?.fullName ?? "—",
      isProbable: false,
      isStarter: idx === 0,
      role: idx === 0 ? "starter" : "reliever",
      pitchingLine: pitchingSummary(p.stats?.pitching),
    };
  });

  const probableStarter = schedGame?.teams?.[side]?.probablePitcher
    ? { mlbId: Number(schedGame.teams[side].probablePitcher.id ?? 0) || null, name: schedGame.teams[side].probablePitcher.fullName ?? null }
    : { mlbId: null, name: null };
  if (probableStarter.mlbId && !pitchers.some((p) => p.mlbId === probableStarter.mlbId)) {
    pitchers.unshift({
      mlbId: probableStarter.mlbId!,
      name: probableStarter.name ?? "—",
      isProbable: true,
      isStarter: true,
      role: "probable",
      pitchingLine: null,
    });
  }

  const isLive = live?.gameData?.status?.abstractGameState === "Live";
  const isFinal = live?.gameData?.status?.abstractGameState === "Final";

  return {
    teamId: team.id ?? null,
    name: team.name ?? "—",
    abbreviation: team.abbreviation ?? "",
    score: teamMeta?.score ?? null,
    record: teamMeta?.leagueRecord ? `${teamMeta.leagueRecord.wins}-${teamMeta.leagueRecord.losses}` : null,
    probableStarter,
    battingOrder,
    pitchers,
    lineupState: inferLineupState(battingOrder, isLive, isFinal),
  };
}

export const getGameHub = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator((data: { gamePk: number }) => data)
  .handler(async ({ data }): Promise<GameHubPayload> => {
    const [schedJson, liveJson] = await Promise.all([
      mlb<any>(`/schedule?sportId=1&gamePk=${data.gamePk}&hydrate=team,probablePitcher,linescore,venue,person`),
      mlb<any>(`/game/${data.gamePk}/feed/live`, MLB11).catch(() => null),
    ]);
    const schedGame = schedJson?.dates?.[0]?.games?.[0];
    if (!schedGame) throw new Error(`Game ${data.gamePk} not found`);

    const status = liveJson?.gameData?.status?.detailedState ?? schedGame.status?.detailedState ?? "Scheduled";
    const abstract = liveJson?.gameData?.status?.abstractGameState ?? schedGame.status?.abstractGameState;
    const isLive = abstract === "Live";
    const isFinal = abstract === "Final";
    const isScheduled = abstract === "Preview";
    const linescore = liveJson?.liveData?.linescore ?? {};
    const currentPlay = liveJson?.liveData?.plays?.currentPlay;

    return {
      gamePk: data.gamePk,
      status,
      isLive,
      isFinal,
      isScheduled,
      startTimeUtc: schedGame.gameDate,
      detailedState: schedGame.status?.detailedState ?? null,
      venue: schedGame.venue?.name ?? liveJson?.gameData?.venue?.name ?? null,
      inning: linescore.currentInning ?? null,
      inningHalf: (linescore.inningHalf as "Top" | "Bottom" | undefined) ?? null,
      currentBatter: currentPlay?.matchup?.batter?.fullName ?? null,
      currentPitcher: currentPlay?.matchup?.pitcher?.fullName ?? null,
      lastPlay: currentPlay?.result?.description ?? null,
      away: pickTeamSide("away", schedGame, liveJson),
      home: pickTeamSide("home", schedGame, liveJson),
      fetchedAt: new Date().toISOString(),
    };
  });
