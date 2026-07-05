import { createServerFn } from "@tanstack/react-start";
import { requireAppMember } from "@/integrations/supabase/member-middleware";
import { fetchActualsForDate, type HitterActual, type PitcherActual } from "@/lib/actuals.functions";
import { fetchScheduleForDate, type GameSummary } from "@/lib/mlb.functions";
import { todayInAppTz } from "@/lib/timezone";
import {
  buildPulseLineupState,
  normalizePulseGameStatus,
  type PulseGameStatus,
  type PulseLineupState,
} from "@/lib/pulse";

export type PulseTeam = {
  id: number | null;
  dbId: string | null;
  name: string;
  abbreviation: string;
  score: number | null;
};

export type PulseProbablePitcher = {
  playerId: string | null;
  mlbId: number | null;
  name: string | null;
  team: string;
  source: "MLB schedule" | "starting_pitchers" | "Unavailable";
  updatedAt: string | null;
};

export type PulseGame = {
  id: string;
  gamePk: number | null;
  dbGameId: string | null;
  away: PulseTeam;
  home: PulseTeam;
  venue: string | null;
  firstPitch: string | null;
  status: PulseGameStatus;
  statusText: string;
  inning: number | null;
  inningHalf: "Top" | "Bottom" | null;
  probablePitchers: {
    away: PulseProbablePitcher;
    home: PulseProbablePitcher;
  };
  lineupState: {
    away: PulseLineupState;
    home: PulseLineupState;
  };
  lastVerifiedAt: string | null;
  updatedAt: string;
};

export type PulseHitter = {
  playerId: string | null;
  mlbId: number | null;
  name: string;
  team: string;
  position: string | null;
  gameId: string;
  gamePk: number | null;
  lineupSlot: number | null;
  lineupState: PulseLineupState;
  today: HitterActual | null;
  seasonContext: null;
  source: "MLB official lineup" | "MLB live boxscore" | "Projected from prior lineup" | "Unavailable";
  updatedAt: string | null;
};

export type PulsePitcher = {
  playerId: string | null;
  mlbId: number | null;
  name: string;
  team: string;
  role: "probable-starter" | "active-pitcher";
  gameId: string;
  gamePk: number | null;
  today: PitcherActual | null;
  source: "MLB schedule" | "starting_pitchers" | "MLB live boxscore" | "Unavailable";
  updatedAt: string | null;
};

export type PulsePayload = {
  date: string;
  generatedAt: string;
  overallUpdatedAt: string;
  hasLiveGames: boolean;
  liveDataMayBeDelayed: boolean;
  games: PulseGame[];
  hitters: PulseHitter[];
  pitchers: PulsePitcher[];
  warnings: string[];
};

type DbGame = {
  id: string;
  mlb_game_id: number;
  home_team_id: string | null;
  away_team_id: string | null;
  first_pitch_at: string | null;
  game_status: string | null;
  ballpark: string | null;
  updated_at: string;
};

type DbTeam = { id: string; abbreviation: string; name: string; mlb_team_id: number | null };
type DbPlayer = { id: string; mlb_id: number | null; name: string; position: string | null; team_id: string | null };

function maxIso(values: Array<string | null | undefined>): string | null {
  const valid = values.filter((v): v is string => !!v);
  if (!valid.length) return null;
  return valid.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

function pitcherFromSchedule(name: string | null, team: string): PulseProbablePitcher {
  return {
    playerId: null,
    mlbId: null,
    name,
    team,
    source: name ? "MLB schedule" : "Unavailable",
    updatedAt: null,
  };
}

function emptyLineupState(): PulseLineupState {
  return buildPulseLineupState({});
}

function dbPitcherForTeam(args: {
  dbGameId: string | null;
  teamDbId: string | null;
  team: string;
  spRows: any[];
  playersById: Map<string, DbPlayer>;
}): PulseProbablePitcher | null {
  if (!args.dbGameId || !args.teamDbId) return null;
  const row = args.spRows.find((sp) => sp.game_id === args.dbGameId && sp.team_id === args.teamDbId);
  if (!row) return null;
  const player = args.playersById.get(row.player_id);
  return {
    playerId: row.player_id,
    mlbId: player?.mlb_id ?? null,
    name: player?.name ?? null,
    team: args.team,
    source: "starting_pitchers",
    updatedAt: row.updated_at ?? row.created_at ?? null,
  };
}

function lineupStateForTeam(args: {
  rows: any[];
  sourceRows: any[];
  teamDbId: string | null;
  gls: any | undefined;
}): PulseLineupState {
  if (!args.teamDbId) return emptyLineupState();
  const rows = args.rows.filter((r) => r.team_id === args.teamDbId);
  const sources = args.sourceRows.filter((r) => r.team_id === args.teamDbId);
  const officialRows = rows.filter((r) => r.lineup_source === "mlb" && r.confirmed === true);
  if (officialRows.length >= 9) {
    return buildPulseLineupState({
      source: "mlb",
      confirmed: true,
      lastVerifiedAt: maxIso(officialRows.map((r) => r.confirmed_at ?? r.imported_at ?? r.updated_at)),
    });
  }
  if (rows.some((r) => r.lineup_source === "diamond_projection")) {
    return buildPulseLineupState({ source: "diamond_projection", confirmed: false });
  }
  if (sources.some((r) => r.source === "diamond_projection")) {
    return buildPulseLineupState({ source: "diamond_projection", confirmed: false });
  }
  if (args.gls?.primary_source === "diamond_projection") {
    return buildPulseLineupState({ source: "diamond_projection", confirmed: false });
  }
  return emptyLineupState();
}

export const getMlbPulse = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator((data: { date?: string } | undefined) => data ?? {})
  .handler(async ({ data, context }): Promise<PulsePayload> => {
    const date = data.date ?? todayInAppTz();
    const generatedAt = new Date().toISOString();
    const warnings: string[] = [];

    const [schedule, actuals] = await Promise.all([
      fetchScheduleForDate(date),
      fetchActualsForDate(date),
    ]);

    const gamePks = schedule.games.map((g) => g.gamePk);
    const { data: dbGames } = gamePks.length
      ? await context.supabase
          .from("games")
          .select("id, mlb_game_id, home_team_id, away_team_id, first_pitch_at, game_status, ballpark, updated_at")
          .in("mlb_game_id", gamePks)
      : { data: [] as DbGame[] };
    const gamesByPk = new Map<number, DbGame>((dbGames ?? []).map((g: any) => [Number(g.mlb_game_id), g]));
    const dbGameIds = (dbGames ?? []).map((g: any) => g.id);

    const [{ data: teams }, { data: glsRows }, { data: lineups }, { data: lineupSources }, { data: spRows }] = await Promise.all([
      context.supabase.from("teams").select("id, abbreviation, name, mlb_team_id"),
      dbGameIds.length
        ? context.supabase.from("game_lineup_status").select("*").in("game_id", dbGameIds)
        : Promise.resolve({ data: [] as any[] }),
      dbGameIds.length
        ? context.supabase
            .from("lineups")
            .select("game_id, player_id, team_id, batting_order, confirmed, confirmed_at, imported_at, updated_at, lineup_source, lineup_status")
            .in("game_id", dbGameIds)
        : Promise.resolve({ data: [] as any[] }),
      dbGameIds.length
        ? context.supabase
            .from("lineup_sources")
            .select("game_id, team_id, source, imported_at, updated_at")
            .in("game_id", dbGameIds)
        : Promise.resolve({ data: [] as any[] }),
      dbGameIds.length
        ? context.supabase.from("starting_pitchers").select("game_id, team_id, player_id, confirmed, created_at, updated_at").in("game_id", dbGameIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const teamById = new Map<string, DbTeam>((teams ?? []).map((t: any) => [t.id, t]));
    const teamByMlbId = new Map<number, DbTeam>((teams ?? []).filter((t: any) => t.mlb_team_id != null).map((t: any) => [Number(t.mlb_team_id), t]));
    const glsByGame = new Map<string, any>((glsRows ?? []).map((r: any) => [r.game_id, r]));

    const playerIds = Array.from(new Set([
      ...(lineups ?? []).map((l: any) => l.player_id),
      ...(spRows ?? []).map((sp: any) => sp.player_id),
    ]));
    const { data: players } = playerIds.length
      ? await context.supabase.from("players").select("id, mlb_id, name, position, team_id").in("id", playerIds)
      : { data: [] as DbPlayer[] };
    const playersById = new Map<string, DbPlayer>((players ?? []).map((p: any) => [p.id, p]));
    const playersByMlb = new Map<number, DbPlayer>((players ?? []).filter((p: any) => p.mlb_id != null).map((p: any) => [Number(p.mlb_id), p]));

    const games = schedule.games.map((g: GameSummary): PulseGame => {
      const db = gamesByPk.get(g.gamePk) ?? null;
      const homeDbTeam = db?.home_team_id ? teamById.get(db.home_team_id) : teamByMlbId.get(g.home.id);
      const awayDbTeam = db?.away_team_id ? teamById.get(db.away_team_id) : teamByMlbId.get(g.away.id);
      const gameLineups = db ? (lineups ?? []).filter((l: any) => l.game_id === db.id) : [];
      const gameLineupSources = db ? (lineupSources ?? []).filter((l: any) => l.game_id === db.id) : [];
      const gls = db ? glsByGame.get(db.id) : undefined;
      const awayLineup = lineupStateForTeam({ rows: gameLineups, sourceRows: gameLineupSources, teamDbId: db?.away_team_id ?? awayDbTeam?.id ?? null, gls });
      const homeLineup = lineupStateForTeam({ rows: gameLineups, sourceRows: gameLineupSources, teamDbId: db?.home_team_id ?? homeDbTeam?.id ?? null, gls });
      const dbAwayPitcher = dbPitcherForTeam({
        dbGameId: db?.id ?? null,
        teamDbId: db?.away_team_id ?? awayDbTeam?.id ?? null,
        team: g.away.abbreviation,
        spRows: spRows ?? [],
        playersById,
      });
      const dbHomePitcher = dbPitcherForTeam({
        dbGameId: db?.id ?? null,
        teamDbId: db?.home_team_id ?? homeDbTeam?.id ?? null,
        team: g.home.abbreviation,
        spRows: spRows ?? [],
        playersById,
      });
      const updatedAt = maxIso([db?.updated_at, gls?.last_refresh_at, actuals.fetchedAt, generatedAt]) ?? generatedAt;
      return {
        id: db?.id ?? String(g.gamePk),
        gamePk: g.gamePk,
        dbGameId: db?.id ?? null,
        away: {
          id: g.away.id,
          dbId: awayDbTeam?.id ?? db?.away_team_id ?? null,
          name: g.away.name,
          abbreviation: g.away.abbreviation,
          score: g.away.score,
        },
        home: {
          id: g.home.id,
          dbId: homeDbTeam?.id ?? db?.home_team_id ?? null,
          name: g.home.name,
          abbreviation: g.home.abbreviation,
          score: g.home.score,
        },
        venue: db?.ballpark ?? g.venue ?? null,
        firstPitch: db?.first_pitch_at ?? g.startTimeUtc ?? null,
        status: normalizePulseGameStatus(g.status),
        statusText: g.status,
        inning: g.inning,
        inningHalf: g.inningHalf,
        probablePitchers: {
          away: dbAwayPitcher ?? pitcherFromSchedule(g.awayProbablePitcher, g.away.abbreviation),
          home: dbHomePitcher ?? pitcherFromSchedule(g.homeProbablePitcher, g.home.abbreviation),
        },
        lineupState: { away: awayLineup, home: homeLineup },
        lastVerifiedAt: maxIso([awayLineup.lastVerifiedAt, homeLineup.lastVerifiedAt, gls?.last_refresh_at]),
        updatedAt,
      };
    });

    const gameByDbId = new Map(games.filter((g) => g.dbGameId).map((g) => [g.dbGameId!, g]));
    const gameByPk = new Map(games.filter((g) => g.gamePk != null).map((g) => [g.gamePk!, g]));

    const hitters: PulseHitter[] = [];
    const seenHitters = new Set<string>();
    for (const l of lineups ?? []) {
      const game = gameByDbId.get(l.game_id);
      const player = playersById.get(l.player_id);
      if (!game || !player) continue;
      const team = player.team_id ? teamById.get(player.team_id)?.abbreviation : null;
      const state = buildPulseLineupState({
        source: l.lineup_source,
        confirmed: l.confirmed,
        lastVerifiedAt: l.confirmed_at ?? l.imported_at ?? l.updated_at,
      });
      const actual = player.mlb_id != null ? actuals.hitters[String(player.mlb_id)] ?? null : null;
      hitters.push({
        playerId: player.id,
        mlbId: player.mlb_id ?? null,
        name: player.name,
        team: team ?? "",
        position: player.position ?? null,
        gameId: game.id,
        gamePk: game.gamePk,
        lineupSlot: state.verified ? l.batting_order : null,
        lineupState: state,
        today: actual && actual.gamePk === game.gamePk ? actual : null,
        seasonContext: null,
        source: state.label === "Official" ? "MLB official lineup" : state.label,
        updatedAt: state.lastVerifiedAt ?? l.imported_at ?? l.updated_at ?? null,
      });
      if (player.mlb_id != null) seenHitters.add(`${game.gamePk}:${player.mlb_id}`);
    }

    for (const actual of Object.values(actuals.hitters)) {
      if (actual.gamePk == null || seenHitters.has(`${actual.gamePk}:${actual.mlb_id}`)) continue;
      const game = gameByPk.get(actual.gamePk);
      if (!game) continue;
      const player = playersByMlb.get(actual.mlb_id);
      hitters.push({
        playerId: player?.id ?? null,
        mlbId: actual.mlb_id,
        name: actual.name ?? player?.name ?? `MLB ${actual.mlb_id}`,
        team: actual.teamAbbrev ?? (player?.team_id ? teamById.get(player.team_id)?.abbreviation ?? "" : ""),
        position: actual.position ?? player?.position ?? null,
        gameId: game.id,
        gamePk: game.gamePk,
        lineupSlot: null,
        lineupState: emptyLineupState(),
        today: actual,
        seasonContext: null,
        source: "MLB live boxscore",
        updatedAt: actuals.fetchedAt,
      });
    }

    const pitchers: PulsePitcher[] = [];
    const seenPitchers = new Set<string>();
    for (const sp of spRows ?? []) {
      const game = gameByDbId.get(sp.game_id);
      const player = playersById.get(sp.player_id);
      if (!game || !player) continue;
      const team = sp.team_id ? teamById.get(sp.team_id)?.abbreviation ?? "" : "";
      const actual = player.mlb_id != null ? actuals.pitchers[String(player.mlb_id)] ?? null : null;
      pitchers.push({
        playerId: player.id,
        mlbId: player.mlb_id ?? null,
        name: player.name,
        team,
        role: "probable-starter",
        gameId: game.id,
        gamePk: game.gamePk,
        today: actual && actual.gamePk === game.gamePk ? actual : null,
        source: "starting_pitchers",
        updatedAt: sp.updated_at ?? sp.created_at ?? null,
      });
      if (player.mlb_id != null) seenPitchers.add(`${game.gamePk}:${player.mlb_id}`);
    }

    for (const actual of Object.values(actuals.pitchers)) {
      if (actual.gamePk == null || seenPitchers.has(`${actual.gamePk}:${actual.mlb_id}`)) continue;
      const game = gameByPk.get(actual.gamePk);
      if (!game) continue;
      const player = playersByMlb.get(actual.mlb_id);
      pitchers.push({
        playerId: player?.id ?? null,
        mlbId: actual.mlb_id,
        name: actual.name ?? player?.name ?? `MLB ${actual.mlb_id}`,
        team: actual.teamAbbrev ?? (player?.team_id ? teamById.get(player.team_id)?.abbreviation ?? "" : ""),
        role: "active-pitcher",
        gameId: game.id,
        gamePk: game.gamePk,
        today: actual,
        source: "MLB live boxscore",
        updatedAt: actuals.fetchedAt,
      });
    }

    if (schedule.games.length === 0) warnings.push("No MLB games returned for this date.");
    const hasLiveGames = games.some((g) => g.status === "live");
    const liveDataMayBeDelayed = hasLiveGames && actuals.liveGames.length === 0;
    if (liveDataMayBeDelayed) warnings.push("Live box-score data may be delayed.");

    return {
      date: schedule.date,
      generatedAt,
      overallUpdatedAt: maxIso([actuals.fetchedAt, ...games.map((g) => g.updatedAt)]) ?? generatedAt,
      hasLiveGames,
      liveDataMayBeDelayed,
      games,
      hitters: hitters.sort((a, b) => a.team.localeCompare(b.team) || (a.lineupSlot ?? 99) - (b.lineupSlot ?? 99) || a.name.localeCompare(b.name)),
      pitchers: pitchers.sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)),
      warnings,
    };
  });
