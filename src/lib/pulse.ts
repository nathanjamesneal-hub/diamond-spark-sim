export type PulseGameStatus =
  | "upcoming"
  | "live"
  | "final"
  | "delayed"
  | "postponed"
  | "unavailable";

export type PulseLineupLabel =
  | "Official"
  | "Projected from prior lineup"
  | "Unavailable";

export type PulseLineupState = {
  label: PulseLineupLabel;
  source: string | null;
  lastVerifiedAt: string | null;
  verified: boolean;
};

function lower(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export function normalizePulseGameStatus(status: string | null | undefined): PulseGameStatus {
  const s = lower(status);
  if (!s) return "unavailable";
  if (s.includes("final") || s.includes("game over") || s.includes("completed")) return "final";
  if (s.includes("postponed") || s.includes("cancelled") || s.includes("canceled")) return "postponed";
  if (s.includes("delayed") || s.includes("suspended")) return "delayed";
  if (s.includes("in progress") || s.includes("live") || s.includes("manager challenge") || s.includes("review")) return "live";
  if (s.includes("scheduled") || s.includes("pre-game") || s.includes("pregame") || s.includes("warmup")) return "upcoming";
  return "unavailable";
}

export function isMlbOfficialLineupSource(source: string | null | undefined): boolean {
  return lower(source) === "mlb";
}

export function lineupLabelForSource(source: string | null | undefined, confirmed?: boolean | null): PulseLineupLabel {
  if (isMlbOfficialLineupSource(source) && confirmed === true) return "Official";
  if (lower(source) === "diamond_projection") return "Projected from prior lineup";
  return "Unavailable";
}

export function buildPulseLineupState(args: {
  source?: string | null;
  confirmed?: boolean | null;
  lastVerifiedAt?: string | null;
}): PulseLineupState {
  const label = lineupLabelForSource(args.source, args.confirmed);
  return {
    label,
    source: args.source ?? null,
    lastVerifiedAt: label === "Official" ? args.lastVerifiedAt ?? null : null,
    verified: label === "Official",
  };
}
