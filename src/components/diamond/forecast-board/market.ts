/**
 * Forecast Board market definitions. Drives the Prob/Mean columns,
 * the sort key, the actual-stat formatter, and the rows that are
 * eligible for the current market.
 */
import type {
  DiamondHitterCard,
  DiamondPitcherCard,
  ForecastActuals,
} from "@/lib/projections.functions";

export type Market =
  | "hit"        // hitter — Hit 1+
  | "hr"         // hitter — HR 1+
  | "tb"         // hitter — Total Bases
  | "rbi"        // hitter — RBI 1+
  | "pitcher_k"  // pitcher — Strikeouts
  | "pitcher_outs"
  | "pitcher_bb"
  | "pitcher_win"
  | "pitcher_qs";

export const HITTER_MARKETS: Market[] = ["hit", "hr", "tb", "rbi"];
export const PITCHER_MARKETS: Market[] = [
  "pitcher_k", "pitcher_outs", "pitcher_bb", "pitcher_win", "pitcher_qs",
];

export function isPitcherMarket(m: Market): boolean {
  return m.startsWith("pitcher_");
}

export const MARKET_META: Record<Market, { label: string; meanLabel: string; meanUnit: string }> = {
  hit:          { label: "Hit 1+",         meanLabel: "Hits",  meanUnit: "H" },
  hr:           { label: "HR 1+",          meanLabel: "HR",    meanUnit: "HR" },
  tb:           { label: "Total Bases",    meanLabel: "TB",    meanUnit: "TB" },
  rbi:          { label: "RBI 1+",         meanLabel: "RBI",   meanUnit: "RBI" },
  pitcher_k:    { label: "Pitcher · Ks",   meanLabel: "K",     meanUnit: "K" },
  pitcher_outs: { label: "Pitcher · Outs", meanLabel: "Outs",  meanUnit: "Outs" },
  pitcher_bb:   { label: "Pitcher · Walks",meanLabel: "BB",    meanUnit: "BB" },
  pitcher_win:  { label: "Pitcher · Win",  meanLabel: "Win %", meanUnit: "" },
  pitcher_qs:   { label: "Pitcher · QS",   meanLabel: "QS %",  meanUnit: "" },
};

export function hitterProb(h: DiamondHitterCard, m: Market): number | null {
  switch (m) {
    case "hit": return h.hit_probability;
    case "hr":  return h.hr_probability;
    case "tb":  return h.total_base_probability;
    case "rbi": return h.rbi_probability;
    default: return null;
  }
}
export function hitterMean(h: DiamondHitterCard, m: Market): number | null {
  switch (m) {
    case "hit": return h.hit_mean;
    case "hr":  return h.hr_mean;
    case "tb":  return h.tb_mean;
    case "rbi": return h.rbi_mean;
    default: return null;
  }
}

export function pitcherProb(p: DiamondPitcherCard, m: Market): number | null {
  switch (m) {
    case "pitcher_win": return p.pitcher_win_probability;
    case "pitcher_qs":  return p.quality_start_probability;
    default: return null; // Ks / Outs / BB are mean-driven, not single-prob
  }
}
export function pitcherMean(p: DiamondPitcherCard, m: Market): number | null {
  switch (m) {
    case "pitcher_k":    return p.k_mean;
    case "pitcher_outs": return p.projected_outs;
    case "pitcher_bb":   return p.bb_mean;
    default: return null;
  }
}

/** Format the live/final actual for the selected market. */
export function formatActual(a: ForecastActuals | null, m: Market): string {
  if (!a) return "";
  switch (m) {
    case "hit": {
      if (a.hits == null || a.ab == null) return "";
      return `${a.hits}-for-${a.ab}`;
    }
    case "hr":  return a.home_runs != null ? `${a.home_runs} HR` : "";
    case "tb":  return a.total_bases != null ? `${a.total_bases} TB` : "";
    case "rbi": return a.rbis != null ? `${a.rbis} RBI` : "";
    case "pitcher_k":    return a.strikeouts != null ? `${a.strikeouts} K` : "";
    case "pitcher_bb":   return a.walks != null ? `${a.walks} BB` : "";
    case "pitcher_outs": {
      // projection_results doesn't carry outs/IP for pitchers — leave blank.
      return "";
    }
    case "pitcher_win":
    case "pitcher_qs":
      return ""; // outcome not stored in projection_results
  }
}
