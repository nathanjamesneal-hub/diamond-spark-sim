/**
 * Box-score actuals for finalized games on a given slate date.
 * Pulls live MLB boxscores for each gamePk on the date, extracts per-player
 * counting stats, and returns lookup maps keyed by mlb_id.
 *
 * Display-only. Never invents results — if a game isn't Final, its players
 * are simply omitted from the maps. Consumers must show "Pending" themselves.
 *
 * TODO: If we ever persist box-score actuals into the database, switch this
 * to read from there instead of hitting the MLB API for each request.
 */
import { createServerFn } from "@tanstack/react-start";

const BASE = "https://statsapi.mlb.com/api/v1";
const BASE_V11 = "https://statsapi.mlb.com/api/v1.1";

async function mlbFetch<T>(path: string, base = BASE): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`MLB ${res.status} ${path}`);
  return (await res.json()) as T;
}

export type HitterActual = {
  mlb_id: number;
  H: number;
  HR: number;
  RBI: number;
  R: number;
  TB: number;
  SB: number;
  K: number;
};

export type PitcherActual = {
  mlb_id: number;
  outs: number;
  K: number;
  BB: number;
  ER: number;
  H: number;
  win: boolean;
  qualityStart: boolean; // outs >= 18 AND ER <= 3
};

export type ActualsPayload = {
  date: string;
  finalGames: number[]; // gamePks that are Final
  pendingGames: number[]; // gamePks that are not yet Final
  hitters: Record<string, HitterActual>;
  pitchers: Record<string, PitcherActual>;
};

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && isFinite(n) ? n : 0;
}

function parseInningsToOuts(ip: unknown): number {
  // MLB returns IP as a string like "5.2" meaning 5 innings, 2 outs.
  if (ip == null) return 0;
  const s = String(ip);
  const [innStr, fracStr] = s.split(".");
  const inn = parseInt(innStr || "0", 10) || 0;
  const frac = parseInt(fracStr || "0", 10) || 0;
  return inn * 3 + frac;
}

function chicagoToday(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

export const getActualsForDate = createServerFn({ method: "GET" })
  .inputValidator((data: { date?: string } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<ActualsPayload> => {
    const date = data.date ?? chicagoToday();
    const hitters: Record<string, HitterActual> = {};
    const pitchers: Record<string, PitcherActual> = {};
    const finalGames: number[] = [];
    const pendingGames: number[] = [];

    let sched: any;
    try {
      sched = await mlbFetch<any>(`/schedule?sportId=1&date=${date}`);
    } catch (e) {
      console.error("getActualsForDate: schedule fetch failed", e);
      return { date, finalGames, pendingGames, hitters, pitchers };
    }

    const games: { gamePk: number; isFinal: boolean }[] = [];
    for (const d of sched.dates ?? []) {
      for (const g of d.games ?? []) {
        games.push({
          gamePk: g.gamePk,
          isFinal: g.status?.abstractGameState === "Final",
        });
      }
    }

    await Promise.all(
      games.map(async (g) => {
        if (!g.isFinal) {
          pendingGames.push(g.gamePk);
          return;
        }
        finalGames.push(g.gamePk);
        let box: any;
        let feed: any;
        try {
          // feed/live gives decisions (winner) + boxscore
          feed = await mlbFetch<any>(`/game/${g.gamePk}/feed/live`, BASE_V11);
          box = feed?.liveData?.boxscore;
        } catch (e) {
          console.error(`getActualsForDate: feed failed for ${g.gamePk}`, e);
          return;
        }
        if (!box) return;

        const winningPitcherId: number | null =
          feed?.liveData?.decisions?.winner?.id ?? null;

        for (const side of ["home", "away"] as const) {
          const players = box.teams?.[side]?.players ?? {};
          for (const key of Object.keys(players)) {
            const p = players[key];
            const mlbId = p?.person?.id;
            if (!mlbId) continue;

            const bat = p?.stats?.batting;
            if (bat && (bat.atBats != null || bat.plateAppearances != null)) {
              const h = num(bat.hits);
              const hr = num(bat.homeRuns);
              const double = num(bat.doubles);
              const triple = num(bat.triples);
              const single = Math.max(0, h - double - triple - hr);
              const tb = single + 2 * double + 3 * triple + 4 * hr;
              hitters[String(mlbId)] = {
                mlb_id: mlbId,
                H: h,
                HR: hr,
                RBI: num(bat.rbi),
                R: num(bat.runs),
                TB: tb,
                SB: num(bat.stolenBases),
                K: num(bat.strikeOuts),
              };
            }

            const pit = p?.stats?.pitching;
            if (pit && (pit.battersFaced != null || pit.inningsPitched != null)) {
              const outs = parseInningsToOuts(pit.inningsPitched);
              const er = num(pit.earnedRuns);
              pitchers[String(mlbId)] = {
                mlb_id: mlbId,
                outs,
                K: num(pit.strikeOuts),
                BB: num(pit.baseOnBalls),
                ER: er,
                H: num(pit.hits),
                win: winningPitcherId === mlbId,
                qualityStart: outs >= 18 && er <= 3,
              };
            }
          }
        }
      }),
    );

    return { date, finalGames, pendingGames, hitters, pitchers };
  });
