/**
 * Official Forecast Eligibility.
 *
 * Pure: takes already-loaded DB rows and returns whether a game qualifies
 * for an OFFICIAL Diamond forecast. The rule is strict by design:
 *
 *   - both starting pitchers are confirmed
 *   - both lineups present 9 unique confirmed batters in slots 1..9
 *   - lineup source is not a projection feed (projected/rotowire/etc.)
 *   - game has not started yet (status + first-pitch wall-clock backstop)
 *
 * Anything else is preview-only. The result of this function is the single
 * source of truth that the write path and the public read path both use.
 */

export type EligibilityLineupRow = {
  player_id: string;
  team_id: string | null;
  batting_order: number | null;
  lineup_status?: string | null;
  lineup_source?: string | null;
  confirmed?: boolean | null;
  locked_at?: string | null;
};

export type EligibilityStarterRow = {
  team_id: string | null;
  player_id: string;
  confirmed?: boolean | null;
};

export type EligibilityGameLineupStatus = {
  status?: string | null;
  primary_source?: string | null;
} | null | undefined;

export type EligibilityGame = {
  id: string;
  home_team_id: string | null;
  away_team_id: string | null;
  game_status?: string | null;
  first_pitch_at?: string | null;
};

export type EligibilityResult = {
  eligible: boolean;
  reason: string | null;
  gameStarted: boolean;
};

const CONFIRMED_STATUSES = new Set(["locked", "confirmed", "official"]);
const PROJECTED_SOURCES = new Set(["projected", "rotowire", "projection", "draftkings_projected"]);

function lineupRowConfirmed(row: EligibilityLineupRow, gls: EligibilityGameLineupStatus): boolean {
  if (row.confirmed === true) return true;
  if (row.locked_at != null) return true;
  const rowStatus = (row.lineup_status ?? "").toLowerCase();
  if (CONFIRMED_STATUSES.has(rowStatus)) return true;
  const glsStatus = (gls?.status ?? "").toLowerCase();
  if (CONFIRMED_STATUSES.has(glsStatus)) return true;
  return false;
}

function lineupRowIsProjectedSource(row: EligibilityLineupRow, gls: EligibilityGameLineupStatus): boolean {
  const src = (row.lineup_source ?? gls?.primary_source ?? "").toLowerCase();
  if (!src) return false;
  return PROJECTED_SOURCES.has(src);
}

export function gameHasStarted(
  status: string | null | undefined,
  firstPitchAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const s = (status ?? "").toLowerCase();
  if (
    s.includes("in progress") ||
    s.includes("live") ||
    s.includes("final") ||
    s.includes("game over") ||
    s.includes("completed") ||
    s.includes("manager challenge") ||
    s.includes("suspended") ||
    (s.includes("delayed") && !s.includes("delayed start"))
  ) {
    return true;
  }
  if (firstPitchAt) {
    const t = Date.parse(firstPitchAt);
    if (Number.isFinite(t) && now >= t) return true;
  }
  return false;
}

function teamSlotsValid(
  teamId: string | null,
  lineups: EligibilityLineupRow[],
  gls: EligibilityGameLineupStatus,
): { ok: boolean; reason?: string } {
  if (!teamId) return { ok: false, reason: "missing team id" };
  const rows = lineups.filter((l) => l.team_id === teamId);
  if (!rows.length) return { ok: false, reason: "no lineup rows" };

  // Must be entirely confirmed (no projected rows allowed).
  for (const r of rows) {
    if (!lineupRowConfirmed(r, gls)) return { ok: false, reason: "lineup not fully confirmed" };
    if (lineupRowIsProjectedSource(r, gls)) {
      return { ok: false, reason: "lineup source is a projection feed" };
    }
  }

  // Must have exactly 9 unique batting orders 1..9 with unique player ids.
  const slots = new Map<number, string>();
  for (const r of rows) {
    if (!r.batting_order || r.batting_order < 1 || r.batting_order > 9) continue;
    if (slots.has(r.batting_order)) {
      return { ok: false, reason: `duplicate batting order ${r.batting_order}` };
    }
    slots.set(r.batting_order, r.player_id);
  }
  if (slots.size !== 9) return { ok: false, reason: `expected 9 batting slots, got ${slots.size}` };
  const uniquePlayers = new Set(slots.values());
  if (uniquePlayers.size !== 9) return { ok: false, reason: "lineup contains duplicate players" };
  return { ok: true };
}

export function evaluateOfficialEligibility(args: {
  game: EligibilityGame;
  lineups: EligibilityLineupRow[];
  starters: EligibilityStarterRow[];
  gls?: EligibilityGameLineupStatus;
  now?: number;
}): EligibilityResult {
  const { game, lineups, starters, gls, now } = args;

  const started = gameHasStarted(game.game_status, game.first_pitch_at, now);
  if (started) {
    return { eligible: false, gameStarted: true, reason: "game has started" };
  }

  const homeSp = starters.find((s) => s.team_id === game.home_team_id && s.confirmed === true);
  if (!homeSp) return { eligible: false, gameStarted: false, reason: "home starter not confirmed" };
  const awaySp = starters.find((s) => s.team_id === game.away_team_id && s.confirmed === true);
  if (!awaySp) return { eligible: false, gameStarted: false, reason: "away starter not confirmed" };

  const home = teamSlotsValid(game.home_team_id, lineups, gls);
  if (!home.ok) return { eligible: false, gameStarted: false, reason: `home: ${home.reason}` };
  const away = teamSlotsValid(game.away_team_id, lineups, gls);
  if (!away.ok) return { eligible: false, gameStarted: false, reason: `away: ${away.reason}` };

  return { eligible: true, gameStarted: false, reason: null };
}
