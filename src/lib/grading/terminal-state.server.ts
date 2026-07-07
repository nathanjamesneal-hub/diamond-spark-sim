/**
 * Terminal-state resolver — flips a game to Final only when official
 * final evidence exists. Never infers a Final purely from a score value.
 *
 * Persists source status + evidence on games.terminal_state_* fields so
 * source lag is auditable separately from worker health.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type TerminalCheckInput = {
  gameId: string;
  detailedState: string | null;
  boxscoreFinalEvidence?: {
    codedGameState?: string | null;
    abstractGameState?: string | null;
    isFinal?: boolean | null;
    finalInning?: number | null;
    boxscoreFetchedAt?: string;
    source?: string;
  } | null;
};

export type TerminalCheckResult = {
  isFinal: boolean;
  source: string;
  evidence: Record<string, unknown>;
};

/** Pure — decide whether we have enough evidence to call a game Final. */
export function resolveTerminalState(input: TerminalCheckInput): TerminalCheckResult {
  const state = (input.detailedState ?? "").toLowerCase();
  if (state.includes("final") || state.includes("game over") || state.includes("completed")) {
    return {
      isFinal: true,
      source: "mlb_detailed_state",
      evidence: { detailedState: input.detailedState },
    };
  }
  const b = input.boxscoreFinalEvidence;
  if (b && (b.isFinal === true
    || (b.codedGameState && ["F", "FT", "FR"].includes(String(b.codedGameState)))
    || (b.abstractGameState && String(b.abstractGameState).toLowerCase() === "final"))) {
    return {
      isFinal: true,
      source: b.source ?? "mlb_boxscore",
      evidence: {
        codedGameState: b.codedGameState,
        abstractGameState: b.abstractGameState,
        isFinal: b.isFinal,
        finalInning: b.finalInning,
        detailedState: input.detailedState,
        boxscoreFetchedAt: b.boxscoreFetchedAt,
      },
    };
  }
  return {
    isFinal: false,
    source: "mlb_detailed_state",
    evidence: { detailedState: input.detailedState, note: "no_final_evidence" },
  };
}

/** Persist terminal-state resolution on the games row when Final. */
export async function persistTerminalState(
  admin: SupabaseClient<any>,
  input: TerminalCheckInput,
): Promise<TerminalCheckResult> {
  const res = resolveTerminalState(input);
  if (res.isFinal) {
    await admin.from("games").update({
      terminal_state_source: res.source,
      terminal_state_evidence: res.evidence,
      terminal_state_resolved_at: new Date().toISOString(),
    }).eq("id", input.gameId);
  } else {
    // Record source status without marking Final — audit lag separately.
    await admin.from("games").update({
      terminal_state_source: res.source,
      terminal_state_evidence: res.evidence,
    }).eq("id", input.gameId);
  }
  return res;
}
