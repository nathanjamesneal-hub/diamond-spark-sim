import { createServerFn } from "@tanstack/react-start";

/**
 * MLB Stats API server functions.
 * All calls hit statsapi.mlb.com — public, no auth, generous rate limits.
 * Kept narrow: each fn returns a plain serializable DTO shaped for the UI.
 */

const BASE = "https://statsapi.mlb.com/api/v1";

async function mlbFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`MLB API ${res.status}: ${path}`);
  }
  return (await res.json()) as T;
}

function todayIsoDate(): string {
  // MLB API uses YYYY-MM-DD in America/New_York-ish; we use UTC date which
  // is close enough for a v1 (within hours either side).
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function currentSeason(): number {
  const d = new Date();
  // Use previous year before mid-March (offseason); otherwise current year.
  const month = d.getUTCMonth() + 1;
  return month < 3 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickName(player: any): string | null {
  return player?.fullName ?? player?.person?.fullName ?? null;
}

// ------------------------ Schedule / Scores ------------------------

export type TeamLineScore = {
  runs: number | null;
  hits: number | null;
  errors: number | null;
};

export type LiveTeamStats = {
  runs: number | null;
  hits: number | null;
  errors: number | null;
  leftOnBase: number | null;
  homeRuns: number | null;
  walks: number | null;
  strikeouts: number | null;
};

export type LivePlayerStat = {
  id: number;
  name: string;
  position: string;
  summary: string;
};

export type LiveGameState = {
  balls: number | null;
  strikes: number | null;
  outs: number | null;
  basesOccupied: string[];
  currentBatter: string | null;
  currentPitcher: string | null;
  lastPlay: string | null;
  home: LiveTeamStats;
  away: LiveTeamStats;
  battingLeaders: LivePlayerStat[];
  pitchingLeaders: LivePlayerStat[];
};

export type GameSummary = {
  gamePk: number;
  status: string;              // "Scheduled" | "In Progress" | "Final" | ...
  isLive: boolean;
  isFinal: boolean;
  startTimeUtc: string;
  inning: number | null;
  inningHalf: "Top" | "Bottom" | null;
  home: {
    id: number;
    name: string;
    abbreviation: string;
    score: number | null;
    record: string;
    line: TeamLineScore;
  };
  away: {
    id: number;
    name: string;
    abbreviation: string;
    score: number | null;
    record: string;
    line: TeamLineScore;
  };
  venue: string;
  homeProbablePitcher: string | null;
  awayProbablePitcher: string | null;
  live: LiveGameState | null;
};

function teamLineFrom(linescoreTeam: any, scheduleTeam: any): TeamLineScore {
  return {
    runs: toNumber(scheduleTeam?.score ?? linescoreTeam?.runs),
    hits: toNumber(linescoreTeam?.hits),
    errors: toNumber(linescoreTeam?.errors),
  };
}

function emptyLiveTeamStats(): LiveTeamStats {
  return {
    runs: null,
    hits: null,
    errors: null,
    leftOnBase: null,
    homeRuns: null,
    walks: null,
    strikeouts: null,
  };
}

function liveTeamStatsFrom(boxTeam: any, lineTeam: any): LiveTeamStats {
  const batting = boxTeam?.teamStats?.batting ?? {};
  return {
    runs: toNumber(lineTeam?.runs ?? batting.runs),
    hits: toNumber(lineTeam?.hits ?? batting.hits),
    errors: toNumber(lineTeam?.errors),
    leftOnBase: toNumber(batting.leftOnBase),
    homeRuns: toNumber(batting.homeRuns),
    walks: toNumber(batting.baseOnBalls),
    strikeouts: toNumber(batting.strikeOuts),
  };
}

function basesOccupied(linescore: any): string[] {
  const offense = linescore?.offense ?? {};
  const bases: string[] = [];
  if (offense.first) bases.push("1B");
  if (offense.second) bases.push("2B");
  if (offense.third) bases.push("3B");
  return bases;
}

function battingSummary(stats: any): string | null {
  if (!stats) return null;
  const ab = toNumber(stats.atBats) ?? 0;
  const hits = toNumber(stats.hits) ?? 0;
  const rbi = toNumber(stats.rbi) ?? 0;
  const hr = toNumber(stats.homeRuns) ?? 0;
  const runs = toNumber(stats.runs) ?? 0;
  if (ab === 0 && hits === 0 && rbi === 0 && hr === 0 && runs === 0) return null;
  const extras = [
    hr > 0 ? `${hr} HR` : null,
    rbi > 0 ? `${rbi} RBI` : null,
    runs > 0 ? `${runs} R` : null,
  ].filter(Boolean);
  return `${hits}-${ab}${extras.length ? `, ${extras.join(", ")}` : ""}`;
}

function pitchingSummary(stats: any): string | null {
  if (!stats) return null;
  const ip = stats.inningsPitched;
  const strikeouts = toNumber(stats.strikeOuts) ?? 0;
  const earnedRuns = toNumber(stats.earnedRuns) ?? 0;
  const walks = toNumber(stats.baseOnBalls) ?? 0;
  if (!ip && strikeouts === 0 && earnedRuns === 0 && walks === 0) return null;
  return `${ip ?? "0.0"} IP, ${earnedRuns} ER, ${strikeouts} K${walks ? `, ${walks} BB` : ""}`;
}

function livePlayerLeaders(players: Record<string, any>, group: "batting" | "pitching"): LivePlayerStat[] {
  return Object.values(players ?? {})
    .map((p: any) => {
      const stats = p.stats?.[group];
      const summary = group === "batting" ? battingSummary(stats) : pitchingSummary(stats);
      if (!summary) return null;
      const score =
        group === "batting"
          ? (toNumber(stats?.hits) ?? 0) * 4 + (toNumber(stats?.homeRuns) ?? 0) * 5 + (toNumber(stats?.rbi) ?? 0) * 2
          : (toNumber(stats?.outs) ?? 0) + (toNumber(stats?.strikeOuts) ?? 0) * 2 - (toNumber(stats?.earnedRuns) ?? 0) * 3;
      return {
        id: p.person?.id,
        name: p.person?.fullName,
        position: p.position?.abbreviation ?? "",
        summary,
        score,
      };
    })
    .filter((p: any): p is LivePlayerStat & { score: number } => !!p?.id && !!p?.name)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ score: _score, ...p }) => p);
}

async function getLiveGameState(gamePk: number): Promise<LiveGameState> {
  const json = await mlbFetch<any>(`/game/${gamePk}/feed/live`);
  const linescore = json.liveData?.linescore ?? {};
  const boxscore = json.liveData?.boxscore ?? {};
  const currentPlay = json.liveData?.plays?.currentPlay ?? {};
  const homePlayers = boxscore.teams?.home?.players ?? {};
  const awayPlayers = boxscore.teams?.away?.players ?? {};
  const allPlayers = { ...awayPlayers, ...homePlayers };

  return {
    balls: toNumber(linescore.balls ?? currentPlay.count?.balls),
    strikes: toNumber(linescore.strikes ?? currentPlay.count?.strikes),
    outs: toNumber(linescore.outs ?? currentPlay.count?.outs),
    basesOccupied: basesOccupied(linescore),
    currentBatter: pickName(linescore.offense?.batter ?? currentPlay.matchup?.batter),
    currentPitcher: pickName(linescore.defense?.pitcher ?? currentPlay.matchup?.pitcher),
    lastPlay: currentPlay.result?.description ?? null,
    home: liveTeamStatsFrom(boxscore.teams?.home, linescore.teams?.home),
    away: liveTeamStatsFrom(boxscore.teams?.away, linescore.teams?.away),
    battingLeaders: livePlayerLeaders(allPlayers, "batting"),
    pitchingLeaders: livePlayerLeaders(allPlayers, "pitching"),
  };
}

export const getSchedule = createServerFn({ method: "GET" })
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data }): Promise<{ date: string; games: GameSummary[] }> => {
    const date = data.date ?? todayIsoDate();
    const json = await mlbFetch<any>(
      `/schedule?sportId=1&date=${date}&hydrate=team,linescore,probablePitcher`,
    );
    const games: GameSummary[] = [];
    for (const d of json.dates ?? []) {
      for (const g of d.games ?? []) {
        const status = g.status?.detailedState ?? g.status?.abstractGameState ?? "Scheduled";
        const isLive = g.status?.abstractGameState === "Live";
        const isFinal = g.status?.abstractGameState === "Final";
        games.push({
          gamePk: g.gamePk,
          status,
          isLive,
          isFinal,
          startTimeUtc: g.gameDate,
          inning: g.linescore?.currentInning ?? null,
          inningHalf:
            g.linescore?.inningHalf === "Top"
              ? "Top"
              : g.linescore?.inningHalf === "Bottom"
                ? "Bottom"
                : null,
          home: {
            id: g.teams.home.team.id,
            name: g.teams.home.team.name,
            abbreviation: g.teams.home.team.abbreviation ?? "",
            score: g.teams.home.score ?? null,
            line: teamLineFrom(g.linescore?.teams?.home, g.teams.home),
            record: g.teams.home.leagueRecord
              ? `${g.teams.home.leagueRecord.wins}-${g.teams.home.leagueRecord.losses}`
              : "",
          },
          away: {
            id: g.teams.away.team.id,
            name: g.teams.away.team.name,
            abbreviation: g.teams.away.team.abbreviation ?? "",
            score: g.teams.away.score ?? null,
            line: teamLineFrom(g.linescore?.teams?.away, g.teams.away),
            record: g.teams.away.leagueRecord
              ? `${g.teams.away.leagueRecord.wins}-${g.teams.away.leagueRecord.losses}`
              : "",
          },
          venue: g.venue?.name ?? "",
          homeProbablePitcher: g.teams.home.probablePitcher?.fullName ?? null,
          awayProbablePitcher: g.teams.away.probablePitcher?.fullName ?? null,
          live: null,
        });
      }
    }

    const liveResults = await Promise.allSettled(
      games
        .filter((g) => g.isLive)
        .map(async (g) => ({ gamePk: g.gamePk, live: await getLiveGameState(g.gamePk) })),
    );
    const liveByGamePk = new Map<number, LiveGameState>();
    for (const result of liveResults) {
      if (result.status === "fulfilled") liveByGamePk.set(result.value.gamePk, result.value.live);
    }
    for (const game of games) {
      const live = liveByGamePk.get(game.gamePk);
      if (!live) continue;
      game.live = live;
      game.home.line = {
        runs: live.home.runs ?? game.home.line.runs,
        hits: live.home.hits ?? game.home.line.hits,
        errors: live.home.errors ?? game.home.line.errors,
      };
      game.away.line = {
        runs: live.away.runs ?? game.away.line.runs,
        hits: live.away.hits ?? game.away.line.hits,
        errors: live.away.errors ?? game.away.line.errors,
      };
    }
    return { date, games };
  });

// ------------------------ Standings ------------------------

export type StandingsTeam = {
  teamId: number;
  name: string;
  abbreviation: string;
  wins: number;
  losses: number;
  pct: string;
  gb: string;
  streak: string;
  last10: string;
  runDiff: number;
};
export type DivisionStandings = {
  divisionId: number;
  divisionName: string;
  teams: StandingsTeam[];
};

export const getStandings = createServerFn({ method: "GET" })
  .inputValidator((data: { season?: number }) => data ?? {})
  .handler(async ({ data }): Promise<{ season: number; divisions: DivisionStandings[] }> => {
    const season = data.season ?? currentSeason();
    const json = await mlbFetch<any>(
      `/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason&hydrate=team`,
    );

    const divisionNames: Record<number, string> = {
      200: "AL West",
      201: "AL East",
      202: "AL Central",
      203: "NL West",
      204: "NL East",
      205: "NL Central",
    };

    const divisions: DivisionStandings[] = [];
    for (const rec of json.records ?? []) {
      const teams: StandingsTeam[] = (rec.teamRecords ?? []).map((t: any) => {
        const last10 = (t.records?.splitRecords ?? []).find(
          (s: any) => s.type === "lastTen",
        );
        return {
          teamId: t.team.id,
          name: t.team.name,
          abbreviation: t.team.abbreviation ?? "",
          wins: t.wins,
          losses: t.losses,
          pct: t.winningPercentage,
          gb: t.gamesBack,
          streak: t.streak?.streakCode ?? "—",
          last10: last10 ? `${last10.wins}-${last10.losses}` : "—",
          runDiff: (t.runsScored ?? 0) - (t.runsAllowed ?? 0),
        };
      });
      divisions.push({
        divisionId: rec.division.id,
        divisionName: divisionNames[rec.division.id] ?? `Division ${rec.division.id}`,
        teams,
      });
    }
    return { season, divisions };
  });

// ------------------------ Team detail ------------------------

export type RosterPlayer = {
  id: number;
  fullName: string;
  jerseyNumber: string;
  position: string;
  positionGroup: "Pitcher" | "Catcher" | "Infielder" | "Outfielder" | "Other";
};
export type TeamDetail = {
  id: number;
  name: string;
  abbreviation: string;
  locationName: string;
  venue: string;
  league: string;
  division: string;
  firstYearOfPlay: string;
  roster: RosterPlayer[];
};

export const getTeam = createServerFn({ method: "GET" })
  .inputValidator((data: { teamId: number }) => data)
  .handler(async ({ data }): Promise<TeamDetail> => {
    const [teamJson, rosterJson] = await Promise.all([
      mlbFetch<any>(`/teams/${data.teamId}`),
      mlbFetch<any>(`/teams/${data.teamId}/roster?rosterType=active`),
    ]);
    const t = teamJson.teams?.[0] ?? {};
    const roster: RosterPlayer[] = (rosterJson.roster ?? []).map((r: any) => {
      const code = r.position?.type ?? "Other";
      const positionGroup =
        code === "Pitcher" ? "Pitcher"
        : code === "Catcher" ? "Catcher"
        : code === "Infielder" ? "Infielder"
        : code === "Outfielder" ? "Outfielder"
        : "Other";
      return {
        id: r.person.id,
        fullName: r.person.fullName,
        jerseyNumber: r.jerseyNumber ?? "—",
        position: r.position?.abbreviation ?? "—",
        positionGroup,
      };
    });
    return {
      id: t.id,
      name: t.name ?? "Unknown",
      abbreviation: t.abbreviation ?? "",
      locationName: t.locationName ?? "",
      venue: t.venue?.name ?? "",
      league: t.league?.name ?? "",
      division: t.division?.name ?? "",
      firstYearOfPlay: t.firstYearOfPlay ?? "",
      roster,
    };
  });

// ------------------------ Player detail ------------------------

export type PlayerStatLine = {
  season: string;
  team: string;
  // Hitting
  avg?: string; obp?: string; slg?: string; ops?: string;
  hr?: number; rbi?: number; sb?: number; runs?: number; hits?: number; ab?: number;
  // Pitching
  era?: string; whip?: string; w?: number; l?: number; sv?: number; so?: number; ip?: string;
};
export type PlayerDetail = {
  id: number;
  fullName: string;
  primaryNumber: string;
  position: string;
  primaryPositionType: string;
  currentTeam: { id: number; name: string } | null;
  bats: string;
  throws: string;
  birthCity: string;
  birthCountry: string;
  height: string;
  weight: number | null;
  season: PlayerStatLine | null;
  career: PlayerStatLine | null;
  history: PlayerStatLine[]; // year by year (most recent first)
  group: "hitting" | "pitching";
};

function pickHittingLine(s: any, season: string, team: string): PlayerStatLine {
  return {
    season, team,
    avg: s.avg, obp: s.obp, slg: s.slg, ops: s.ops,
    hr: s.homeRuns, rbi: s.rbi, sb: s.stolenBases, runs: s.runs,
    hits: s.hits, ab: s.atBats,
  };
}
function pickPitchingLine(s: any, season: string, team: string): PlayerStatLine {
  return {
    season, team,
    era: s.era, whip: s.whip, w: s.wins, l: s.losses, sv: s.saves,
    so: s.strikeOuts, ip: s.inningsPitched,
  };
}

export const getPlayer = createServerFn({ method: "GET" })
  .inputValidator((data: { playerId: number }) => data)
  .handler(async ({ data }): Promise<PlayerDetail> => {
    const json = await mlbFetch<any>(
      `/people/${data.playerId}?hydrate=stats(group=[hitting,pitching],type=[yearByYear,season,career]),currentTeam`,
    );
    const p = json.people?.[0];
    if (!p) throw new Error("Player not found");

    const isPitcher = p.primaryPosition?.code === "1" || p.primaryPosition?.type === "Pitcher";
    const group: "hitting" | "pitching" = isPitcher ? "pitching" : "hitting";
    const pick = isPitcher ? pickPitchingLine : pickHittingLine;

    let season: PlayerStatLine | null = null;
    let career: PlayerStatLine | null = null;
    const history: PlayerStatLine[] = [];

    for (const stat of p.stats ?? []) {
      if (stat.group?.displayName !== group) continue;
      const type = stat.type?.displayName;
      for (const split of stat.splits ?? []) {
        const line = pick(
          split.stat ?? {},
          split.season ?? type ?? "",
          split.team?.name ?? "",
        );
        if (type === "season" && !season) season = line;
        else if (type === "career" && !career) {
          career = { ...line, season: "Career", team: "" };
        } else if (type === "yearByYear") {
          history.push(line);
        }
      }
    }
    history.sort((a, b) => (b.season > a.season ? 1 : -1));

    return {
      id: p.id,
      fullName: p.fullName,
      primaryNumber: p.primaryNumber ?? "—",
      position: p.primaryPosition?.abbreviation ?? "—",
      primaryPositionType: p.primaryPosition?.type ?? "",
      currentTeam: p.currentTeam ? { id: p.currentTeam.id, name: p.currentTeam.name } : null,
      bats: p.batSide?.description ?? "—",
      throws: p.pitchHand?.description ?? "—",
      birthCity: p.birthCity ?? "",
      birthCountry: p.birthCountry ?? "",
      height: p.height ?? "",
      weight: p.weight ?? null,
      season,
      career,
      history,
      group,
    };
  });

// ------------------------ Leaderboards ------------------------

export type LeaderRow = {
  rank: number;
  playerId: number;
  playerName: string;
  teamId: number | null;
  teamName: string;
  value: string;
};
export type LeaderboardCategory = {
  key: string;
  label: string;
  rows: LeaderRow[];
};

const LEADER_CATEGORIES: Array<{ key: string; label: string; statGroup: "hitting" | "pitching" }> = [
  { key: "homeRuns",        label: "Home Runs",        statGroup: "hitting" },
  { key: "battingAverage",  label: "Batting Avg",      statGroup: "hitting" },
  { key: "runsBattedIn",    label: "RBI",              statGroup: "hitting" },
  { key: "onBasePlusSlugging", label: "OPS",           statGroup: "hitting" },
  { key: "stolenBases",     label: "Stolen Bases",     statGroup: "hitting" },
  { key: "earnedRunAverage",label: "ERA",              statGroup: "pitching" },
  { key: "strikeouts",      label: "Strikeouts (P)",   statGroup: "pitching" },
  { key: "wins",            label: "Wins",             statGroup: "pitching" },
];

export const getLeaderboards = createServerFn({ method: "GET" })
  .inputValidator((data: { season?: number }) => data ?? {})
  .handler(async ({ data }): Promise<{ season: number; categories: LeaderboardCategory[] }> => {
    const season = data.season ?? currentSeason();
    const categories = await Promise.all(
      LEADER_CATEGORIES.map(async (cat): Promise<LeaderboardCategory> => {
        try {
          const json = await mlbFetch<any>(
            `/stats/leaders?leaderCategories=${cat.key}&season=${season}&sportId=1&limit=10&statGroup=${cat.statGroup}`,
          );
          const rows: LeaderRow[] = (json.leagueLeaders?.[0]?.leaders ?? []).map((l: any) => ({
            rank: l.rank,
            playerId: l.person?.id,
            playerName: l.person?.fullName ?? "—",
            teamId: l.team?.id ?? null,
            teamName: l.team?.name ?? "",
            value: String(l.value),
          }));
          return { key: cat.key, label: cat.label, rows };
        } catch {
          return { key: cat.key, label: cat.label, rows: [] };
        }
      }),
    );
    return { season, categories };
  });
