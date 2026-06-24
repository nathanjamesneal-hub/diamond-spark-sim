/**
 * Lineup provider interface. Each source (MLB, Rotowire, FanGraphs, …)
 * implements this and is registered in providers/index.ts. The Diamond
 * Engine never imports providers directly — it only reads `lineups` /
 * `game_lineup_status` rows produced by the aggregator.
 */

export type ProviderSlot = {
  mlb_id: number;
  name: string;
  position?: string | null;
  order: number; // 1..9
};

export type ProviderTeamLineup = {
  mlb_team_id: number;
  slots: ProviderSlot[];
};

export type ProviderGameLineup = {
  mlb_game_id: number;
  date: string;
  home?: ProviderTeamLineup;
  away?: ProviderTeamLineup;
  scratches?: number[];
};

export type ProviderId =
  | "mlb"
  | "rotowire"
  | "fangraphs"
  | "baseball_press"
  | "diamond_projection"
  | "manual";

export interface LineupProvider {
  id: ProviderId;
  /** 1 = MLB official, 2 = trusted projected (Rotowire), 3 = secondary projected, 4 = derived */
  tier: 1 | 2 | 3 | 4;
  /** Single-source confidence floor used when no other sources agree. */
  baseConfidence: number;
  /** When false the provider is skipped (missing creds, disabled). */
  enabled: boolean;
  /** Pull lineups for the given ISO date (YYYY-MM-DD). Must never throw. */
  fetch(date: string): Promise<ProviderGameLineup[]>;
}

export type ProviderRunResult = {
  id: ProviderId;
  ok: boolean;
  count: number;
  durationMs: number;
  error?: string;
};
