/**
 * Explicit game-state classifier — replaces the broad LIVE_STATUS_RX regex
 * that conflated "Delayed Start", "Postponed", and "Suspended" with games
 * that had actually started.
 *
 * Rules:
 *  - ACTUALLY_STARTED: confirmed live/in-progress/final status, OR an explicit
 *    actual_start_at timestamp <= now.
 *  - PRE_GAME_DELAYED: "delayed start" (or similar pre-first-pitch delay)
 *    WITHOUT any live/in-progress confirmation and WITHOUT actual_start_at.
 *  - POSTPONED_OR_SUSPENDED: not eligible for normal pregame lock.
 *  - NOT_STARTED: scheduled game still pregame.
 *
 * A delayed-start status before actual play must NEVER be treated as started.
 */
export type GameStateClass =
  | "ACTUALLY_STARTED"
  | "PRE_GAME_DELAYED"
  | "POSTPONED_OR_SUSPENDED"
  | "NOT_STARTED";

export type GameStateInput = {
  game_status: string | null | undefined;
  actual_start_at?: string | null | undefined;
  scheduled_first_pitch?: string | null | undefined;
};

const LIVE_RX = /(in\s*progress|live|final|game\s*over|completed|manager\s*challenge)/i;
const DELAYED_PRE_RX = /delayed\s*start/i;
const POSTPONED_RX = /postponed/i;
const SUSPENDED_RX = /suspended/i;
// A bare "delayed" (without "start") means an in-progress delay.
const IN_GAME_DELAY_RX = /^(?!.*delayed\s*start).*\bdelayed\b/i;

export function classifyGameState(input: GameStateInput, now: number = Date.now()): GameStateClass {
  const status = (input.game_status ?? "").trim();

  // Actual start timestamp is authoritative.
  const actualMs = input.actual_start_at ? Date.parse(input.actual_start_at) : NaN;
  if (Number.isFinite(actualMs) && actualMs <= now) return "ACTUALLY_STARTED";

  // Confirmed live/final status.
  if (status && LIVE_RX.test(status)) return "ACTUALLY_STARTED";

  // In-game delay (after first pitch) — treat as started.
  if (status && IN_GAME_DELAY_RX.test(status) && !DELAYED_PRE_RX.test(status)) {
    return "ACTUALLY_STARTED";
  }

  // Explicit pregame delayed-start — NOT started.
  if (status && DELAYED_PRE_RX.test(status)) return "PRE_GAME_DELAYED";

  // Postponed / suspended (not eligible for normal pregame lock).
  if (status && (POSTPONED_RX.test(status) || SUSPENDED_RX.test(status))) {
    return "POSTPONED_OR_SUSPENDED";
  }

  return "NOT_STARTED";
}

/**
 * True only when a NEW pregame snapshot may be created for this game.
 * PRE_GAME_DELAYED is snapshot-eligible so long as no actual start exists.
 */
export function pregameSnapshotAllowed(input: GameStateInput, now: number = Date.now()): boolean {
  const cls = classifyGameState(input, now);
  return cls === "NOT_STARTED" || cls === "PRE_GAME_DELAYED";
}
