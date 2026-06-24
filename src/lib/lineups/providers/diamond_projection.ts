/**
 * Diamond Projection provider — Tier 4, last-resort lineup generator.
 * Derives a projected lineup from:
 *   - the probable starting pitcher (so the opponent's batters are known)
 *   - the team's most recent stored lineup for the season
 * If neither source exists for a team, returns nothing for that team.
 *
 * Confidence scaling lives in the aggregator (60–75 based on how many
 * slots had to be backfilled).
 */
import type { LineupProvider, ProviderGameLineup, ProviderSlot } from "./types";

export const diamondProjectionProvider: LineupProvider = {
  id: "diamond_projection",
  tier: 4,
  baseConfidence: 65,
  enabled: true,
  async fetch(date) {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      const { data: games } = await supabaseAdmin
        .from("games")
        .select("id, mlb_game_id, home_team_id, away_team_id")
        .eq("date", date);
      if (!games?.length) return [];

      const out: ProviderGameLineup[] = [];

      for (const g of games) {
        const teams: { teamId: string | null; side: "home" | "away" }[] = [
          { teamId: g.home_team_id, side: "home" },
          { teamId: g.away_team_id, side: "away" },
        ];

        const sides: { home?: ProviderGameLineup["home"]; away?: ProviderGameLineup["away"] } = {};

        for (const t of teams) {
          if (!t.teamId) continue;

          // Most recent lineup for this team (any prior game)
          const { data: recent } = await supabaseAdmin
            .from("lineups")
            .select("player_id, batting_order, game_id, updated_at")
            .eq("team_id", t.teamId)
            .order("updated_at", { ascending: false })
            .limit(9);

          if (!recent?.length) continue;

          const playerIds = recent.map((r: any) => r.player_id);
          const { data: players } = await supabaseAdmin
            .from("players")
            .select("id, mlb_id, name, position, team_id")
            .in("id", playerIds);
          const byId = new Map((players ?? []).map((p: any) => [p.id, p]));

          // Resolve team_mlb_id
          const { data: teamRow } = await supabaseAdmin
            .from("teams")
            .select("mlb_team_id")
            .eq("id", t.teamId)
            .maybeSingle();
          if (!teamRow?.mlb_team_id) continue;

          // Group by batting order, take first non-null mlb_id
          const slotMap = new Map<number, ProviderSlot>();
          for (const r of recent) {
            const player = byId.get(r.player_id);
            if (!player?.mlb_id) continue;
            if (slotMap.has(r.batting_order)) continue;
            slotMap.set(r.batting_order, {
              mlb_id: player.mlb_id,
              name: player.name ?? `Player ${player.mlb_id}`,
              position: player.position,
              order: r.batting_order,
            });
          }
          const slots = Array.from(slotMap.values()).sort((a, b) => a.order - b.order);
          if (!slots.length) continue;

          sides[t.side] = { mlb_team_id: teamRow.mlb_team_id, slots };
        }

        if (sides.home || sides.away) {
          out.push({
            mlb_game_id: g.mlb_game_id,
            date,
            home: sides.home,
            away: sides.away,
          });
        }
      }

      return out;
    } catch {
      return [];
    }
  },
};
