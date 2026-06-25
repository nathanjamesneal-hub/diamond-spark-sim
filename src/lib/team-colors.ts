/**
 * MLB team color map for Diamond's broadcast-style identity accents.
 * Values are picked for legibility on dark navy surfaces. Use only for
 * rails, swatches, low-opacity washes, and small highlights — never as
 * body text color.
 */

export type TeamColor = { primary: string; secondary: string };

const DIAMOND_BLUE: TeamColor = { primary: "#2F7BFF", secondary: "#5BA0FF" };

// Canonical abbreviation aliases → MLB Stats API standard.
const ALIASES: Record<string, string> = {
  AZ: "ARI",
  CHW: "CWS",
  KCR: "KC",
  SFG: "SF",
  TBR: "TB",
  WSN: "WSH",
  ATH: "OAK",
};

export const TEAM_COLORS: Record<string, TeamColor> = {
  ARI: { primary: "#A71930", secondary: "#E3D4AD" },
  ATL: { primary: "#CE1141", secondary: "#13274F" },
  BAL: { primary: "#DF4601", secondary: "#000000" },
  BOS: { primary: "#BD3039", secondary: "#0C2340" },
  CHC: { primary: "#0E3386", secondary: "#CC3433" },
  CWS: { primary: "#C4CED4", secondary: "#27251F" },
  CIN: { primary: "#C6011F", secondary: "#000000" },
  CLE: { primary: "#E31937", secondary: "#0C2340" },
  COL: { primary: "#33006F", secondary: "#C4CED4" },
  DET: { primary: "#0C2340", secondary: "#FA4616" },
  HOU: { primary: "#EB6E1F", secondary: "#002D62" },
  KC:  { primary: "#004687", secondary: "#BD9B60" },
  LAA: { primary: "#BA0021", secondary: "#003263" },
  LAD: { primary: "#005A9C", secondary: "#A5ACAF" },
  MIA: { primary: "#00A3E0", secondary: "#EF3340" },
  MIL: { primary: "#12284B", secondary: "#FFC52F" },
  MIN: { primary: "#002B5C", secondary: "#D31145" },
  NYM: { primary: "#FF5910", secondary: "#002D72" },
  NYY: { primary: "#0C2340", secondary: "#C4CED3" },
  OAK: { primary: "#003831", secondary: "#EFB21E" },
  PHI: { primary: "#E81828", secondary: "#002D72" },
  PIT: { primary: "#FDB827", secondary: "#27251F" },
  SD:  { primary: "#2F241D", secondary: "#FFC425" },
  SF:  { primary: "#FD5A1E", secondary: "#27251F" },
  SEA: { primary: "#0C2C56", secondary: "#005C5C" },
  STL: { primary: "#C41E3A", secondary: "#0C2340" },
  TB:  { primary: "#092C5C", secondary: "#8FBCE6" },
  TEX: { primary: "#003278", secondary: "#C0111F" },
  TOR: { primary: "#134A8E", secondary: "#1D2D5C" },
  WSH: { primary: "#AB0003", secondary: "#14225A" },
};

export function normalizeTeamAbbrev(abbr: string | null | undefined): string | null {
  if (!abbr) return null;
  const up = abbr.toUpperCase().trim();
  return ALIASES[up] ?? up;
}

export function getTeamColor(abbr: string | null | undefined): TeamColor {
  const key = normalizeTeamAbbrev(abbr);
  if (!key) return DIAMOND_BLUE;
  return TEAM_COLORS[key] ?? DIAMOND_BLUE;
}

/** Inline style for `team-rail` utility. */
export function teamRailStyle(abbr: string | null | undefined): React.CSSProperties {
  return { borderLeftColor: getTeamColor(abbr).primary };
}
