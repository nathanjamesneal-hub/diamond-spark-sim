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
import { requireAppMember } from "@/integrations/supabase/member-middleware";

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
  fetchedAt: string;
  finalGames: number[]; // gamePks that are Final
  liveGames: number[]; // gamePks that are in-progress (Live)
  pendingGames: number[]; // gamePks scheduled but not started
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
  .middleware([requireAppMember])
  .inputValidator((data: { date?: string } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<ActualsPayload> => {
    const date = data.date ?? chicagoToday();
    const hitters: Record<string, HitterActual> = {};
    const pitchers: Record<string, PitcherActual> = {};
    const finalGames: number[] = [];
    const liveGames: number[] = [];
    const pendingGames: number[] = [];

    let sched: any;
    try {
      sched = await mlbFetch<any>(`/schedule?sportId=1&date=${date}`);
    } catch (e) {
      console.error("[actuals] schedule fetch failed", date, e);
      return { date, fetchedAt: new Date().toISOString(), finalGames, liveGames, pendingGames, hitters, pitchers };
    }

    type GameInfo = { gamePk: number; abstract: string; detailed: string; startTime: string };
    const games: GameInfo[] = [];
    for (const d of sched.dates ?? []) {
      for (const g of d.games ?? []) {
        games.push({
          gamePk: g.gamePk,
          abstract: g.status?.abstractGameState ?? "",
          detailed: g.status?.detailedState ?? "",
          startTime: g.gameDate ?? "",
        });
      }
    }

    console.log(
      `[actuals] ${date}: ${games.length} games`,
      games.map((g) => `${g.gamePk}=${g.abstract}/${g.detailed}`).join(" "),
    );

    await Promise.all(
      games.map(async (g) => {
        const isFinal = g.abstract === "Final";
        const isLive = g.abstract === "Live" || g.detailed === "In Progress" || g.detailed === "Manager challenge";
        if (isFinal) finalGames.push(g.gamePk);
        else if (isLive) liveGames.push(g.gamePk);
        else {
          pendingGames.push(g.gamePk);
          return;
        }

        let box: any;
        let feed: any;
        try {
          feed = await mlbFetch<any>(`/game/${g.gamePk}/feed/live`, BASE_V11);
          box = feed?.liveData?.boxscore;
        } catch (e) {
          console.error(`[actuals] feed failed gamePk=${g.gamePk} (${g.abstract})`, e);
          return;
        }
        if (!box) {
          console.warn(`[actuals] no boxscore gamePk=${g.gamePk}`);
          return;
        }

        const winningPitcherId: number | null =
          isFinal ? feed?.liveData?.decisions?.winner?.id ?? null : null;

        let hCount = 0;
        let pCount = 0;
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
              hCount += 1;
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
                qualityStart: isFinal && outs >= 18 && er <= 3,
              };
              pCount += 1;
            }
          }
        }
        console.log(
          `[actuals] gamePk=${g.gamePk} ${g.abstract}/${g.detailed} hitters=${hCount} pitchers=${pCount}`,
        );
      }),
    );

    console.log(
      `[actuals] ${date} summary: final=${finalGames.length} live=${liveGames.length} pending=${pendingGames.length} hitters=${Object.keys(hitters).length} pitchers=${Object.keys(pitchers).length}`,
    );

    return { date, fetchedAt: new Date().toISOString(), finalGames, liveGames, pendingGames, hitters, pitchers };
  });

