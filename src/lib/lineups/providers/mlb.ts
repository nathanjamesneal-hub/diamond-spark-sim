/**
 * MLB official lineups — Tier 1, confidence 100.
 * Reads boxscore battingOrder for each game on the date.
 */
import type { LineupProvider, ProviderGameLineup, ProviderSlot } from "./types";
import { mlbFetch } from "./util";

export const mlbProvider: LineupProvider = {
  id: "mlb",
  tier: 1,
  baseConfidence: 100,
  enabled: true,
  async fetch(date) {
    try {
      const schedule = await mlbFetch<any>(
        `/schedule?sportId=1&date=${date}`,
      );
      const games: { mlb_game_id: number; home_team_id: number; away_team_id: number }[] = [];
      for (const d of schedule.dates ?? []) {
        for (const g of d.games ?? []) {
          if (g.gamePk && g.teams?.home?.team?.id && g.teams?.away?.team?.id) {
            games.push({
              mlb_game_id: g.gamePk,
              home_team_id: g.teams.home.team.id,
              away_team_id: g.teams.away.team.id,
            });
          }
        }
      }

      const out: ProviderGameLineup[] = [];
      await Promise.all(
        games.map(async (g) => {
          try {
            const box = await mlbFetch<any>(`/game/${g.mlb_game_id}/boxscore`);
            const buildSide = (sideKey: "home" | "away", teamId: number) => {
              const sideBox = box.teams?.[sideKey];
              const order = (sideBox?.battingOrder ?? []) as number[];
              if (!order.length) return undefined;
              const slots: ProviderSlot[] = order.map((mlbId, idx) => {
                const person = sideBox.players?.[`ID${mlbId}`]?.person;
                const pos = sideBox.players?.[`ID${mlbId}`]?.position?.abbreviation ?? null;
                return {
                  mlb_id: mlbId,
                  name: person?.fullName ?? `Player ${mlbId}`,
                  position: pos,
                  order: idx + 1,
                };
              });
              return { mlb_team_id: teamId, slots };
            };

            const home = buildSide("home", g.home_team_id);
            const away = buildSide("away", g.away_team_id);
            if (home || away) {
              out.push({ mlb_game_id: g.mlb_game_id, date, home, away });
            }
          } catch {
            /* skip games without boxscores yet */
          }
        }),
      );
      return out;
    } catch {
      return [];
    }
  },
};
