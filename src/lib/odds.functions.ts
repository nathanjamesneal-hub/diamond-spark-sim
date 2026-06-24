/**
 * The Odds API integration — US sportsbooks (DraftKings, FanDuel, Fanatics,
 * bet365, BetMGM, Caesars). Cached 10 minutes per region so we stay deep
 * under the free-tier 500 req/month cap.
 */
import { createServerFn } from "@tanstack/react-start";

const BOOKS = ["draftkings", "fanduel", "fanatics", "betmgm", "bet365", "williamhill_us"];
const SPORT = "baseball_mlb";

type RawEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    title: string;
    last_update: string;
    markets: Array<{
      key: string; // h2h, totals, spreads
      outcomes: Array<{ name: string; price: number; point?: number }>;
    }>;
  }>;
};

export type OddsRow = {
  eventId: string;
  awayTeam: string;
  homeTeam: string;
  commenceTime: string;
  book: string;
  bookKey: string;
  market: "ML" | "TOTAL" | "RUNLINE";
  selection: string;       // "BOS", "Over 8.5", "BOS -1.5"
  line: number | null;
  price: number;           // American odds
  impliedProb: number;
};

type CacheEntry = { at: number; data: OddsRow[] };
let CACHE: CacheEntry | null = null;
const TTL_MS = 10 * 60 * 1000;

function americanToImplied(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

export const getOdds = createServerFn({ method: "GET" })
  .handler(async (): Promise<{ rows: OddsRow[]; fetchedAt: string; configured: boolean }> => {
    const key = process.env.THE_ODDS_API_KEY;
    if (!key) return { rows: [], fetchedAt: new Date().toISOString(), configured: false };

    if (CACHE && Date.now() - CACHE.at < TTL_MS) {
      return { rows: CACHE.data, fetchedAt: new Date(CACHE.at).toISOString(), configured: true };
    }

    const url = new URL(`https://api.the-odds-api.com/v4/sports/${SPORT}/odds`);
    url.searchParams.set("apiKey", key);
    url.searchParams.set("regions", "us,us2");
    url.searchParams.set("markets", "h2h,totals,spreads");
    url.searchParams.set("bookmakers", BOOKS.join(","));
    url.searchParams.set("oddsFormat", "american");

    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Odds API ${res.status}: ${body.slice(0, 200)}`);
    }
    const events: RawEvent[] = await res.json();

    const rows: OddsRow[] = [];
    for (const ev of events) {
      for (const bm of ev.bookmakers) {
        for (const mk of bm.markets) {
          if (mk.key === "h2h") {
            for (const o of mk.outcomes) {
              rows.push({
                eventId: ev.id, awayTeam: ev.away_team, homeTeam: ev.home_team,
                commenceTime: ev.commence_time, book: bm.title, bookKey: bm.key,
                market: "ML", selection: o.name, line: null,
                price: o.price, impliedProb: americanToImplied(o.price),
              });
            }
          } else if (mk.key === "totals") {
            for (const o of mk.outcomes) {
              rows.push({
                eventId: ev.id, awayTeam: ev.away_team, homeTeam: ev.home_team,
                commenceTime: ev.commence_time, book: bm.title, bookKey: bm.key,
                market: "TOTAL", selection: o.name, line: o.point ?? null,
                price: o.price, impliedProb: americanToImplied(o.price),
              });
            }
          } else if (mk.key === "spreads") {
            for (const o of mk.outcomes) {
              rows.push({
                eventId: ev.id, awayTeam: ev.away_team, homeTeam: ev.home_team,
                commenceTime: ev.commence_time, book: bm.title, bookKey: bm.key,
                market: "RUNLINE", selection: o.name, line: o.point ?? null,
                price: o.price, impliedProb: americanToImplied(o.price),
              });
            }
          }
        }
      }
    }

    CACHE = { at: Date.now(), data: rows };
    return { rows, fetchedAt: new Date().toISOString(), configured: true };
  });
