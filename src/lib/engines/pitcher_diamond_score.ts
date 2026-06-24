/**
 * Pitcher Diamond Score
 *
 * Computes a starting pitcher's Diamond Score from six weighted components.
 * Each component is 0-100. Missing inputs fall back to neutral 50 and are
 * recorded under `fallbacks` so the UI can surface what wasn't available.
 *
 * Formula:
 *   diamond_pitcher_score =
 *     strikeout_score          * 0.25 +
 *     contact_suppression_score * 0.20 +
 *     command_score            * 0.15 +
 *     run_prevention_score     * 0.20 +
 *     workload_score           * 0.10 +
 *     win_context_score        * 0.10
 */

const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n));

export type PitcherDiamondScoreInput = {
  strikeoutScore?: number;
  contactSuppressionScore?: number;
  commandScore?: number;
  runPreventionScore?: number;
  workloadScore?: number;
  winContextScore?: number;
};

export function pitcherDiamondScore(input: PitcherDiamondScoreInput): number {
  const strikeout = input.strikeoutScore ?? 50;
  const contact = input.contactSuppressionScore ?? 50;
  const command = input.commandScore ?? 50;
  const runPrev = input.runPreventionScore ?? 50;
  const workload = input.workloadScore ?? 50;
  const winCtx = input.winContextScore ?? 50;

  return Math.round(
    clamp(
      strikeout * 0.25 +
        contact * 0.20 +
        command * 0.15 +
        runPrev * 0.20 +
        workload * 0.10 +
        winCtx * 0.10,
    ),
  );
}

export type PitcherComponentSource = "stat" | "environment" | "fallback";

export type PitcherComponent = {
  value: number;
  source: PitcherComponentSource;
  reason?: string;
};

export type PitcherComponentsBuild = {
  components: {
    strikeoutScore: PitcherComponent;
    contactSuppressionScore: PitcherComponent;
    commandScore: PitcherComponent;
    runPreventionScore: PitcherComponent;
    workloadScore: PitcherComponent;
    winContextScore: PitcherComponent;
  };
  fallbacks: string[];
};

export type PitcherComponentArgs = {
  /** Strikeouts per 9 IP, if known. */
  K9?: number | null;
  /** Walks + hits per IP, if known. */
  WHIP?: number | null;
  /** Walks per 9 IP, if known. */
  BB9?: number | null;
  /** Earned run average, if known. */
  ERA?: number | null;
  /** Projected outs (from Monte Carlo starter distribution). */
  projectedOuts?: number | null;
  /** Pitcher's team win probability from Monte Carlo (0..1). */
  teamWinProbability?: number | null;
  /** 0-100 scale, 50 = neutral run environment. */
  runEnvironmentRating?: number | null;
};

export function buildPitcherComponents(args: PitcherComponentArgs): PitcherComponentsBuild {
  const fallbacks: string[] = [];

  function mk(name: string, raw: number | null, source: PitcherComponentSource, reason?: string): PitcherComponent {
    if (raw == null) {
      fallbacks.push(name);
      return { value: 50, source: "fallback" };
    }
    return { value: Math.round(clamp(raw)), source, reason };
  }

  // K/9: 6 → ~40, 9 → ~62, 12 → ~85
  const strikeoutScore = mk(
    "strikeoutScore",
    args.K9 == null ? null : 40 + (args.K9 - 6) * 7.5,
    "stat",
    args.K9 == null ? undefined : `K/9 ${args.K9.toFixed(1)}`,
  );

  // WHIP: 1.50 → 30, 1.20 → 60, 0.90 → 90
  const contactSuppressionScore = mk(
    "contactSuppressionScore",
    args.WHIP == null ? null : 60 + (1.2 - args.WHIP) * 100,
    "stat",
    args.WHIP == null ? undefined : `WHIP ${args.WHIP.toFixed(2)}`,
  );

  // BB/9: 1.5 → 75, 2.5 → 60, 4.5 → 30
  const commandScore = mk(
    "commandScore",
    args.BB9 == null ? null : 60 - (args.BB9 - 2.5) * 15,
    "stat",
    args.BB9 == null ? undefined : `BB/9 ${args.BB9.toFixed(1)}`,
  );

  // Run prevention: ERA-driven, with a small environment penalty/bonus.
  let runPrevention: PitcherComponent;
  if (args.ERA != null) {
    let v = 60 + (4.0 - args.ERA) * 15;
    if (args.runEnvironmentRating != null) v -= (args.runEnvironmentRating - 50) * 0.4;
    runPrevention = { value: Math.round(clamp(v)), source: "stat", reason: `ERA ${args.ERA.toFixed(2)}` };
  } else if (args.runEnvironmentRating != null) {
    runPrevention = {
      value: Math.round(clamp(50 - (args.runEnvironmentRating - 50) * 0.6)),
      source: "environment",
      reason: `run env ${args.runEnvironmentRating}`,
    };
  } else {
    fallbacks.push("runPreventionScore");
    runPrevention = { value: 50, source: "fallback" };
  }

  // Workload: 12 outs → 35, 15 → 50, 18 → 70, 21 → 85
  let workload: PitcherComponent;
  if (args.projectedOuts != null) {
    workload = {
      value: Math.round(clamp(50 + (args.projectedOuts - 15) * 6.5)),
      source: "environment",
      reason: `${args.projectedOuts.toFixed(1)} projected outs`,
    };
  } else {
    fallbacks.push("workloadScore");
    workload = { value: 50, source: "fallback" };
  }

  // Win context: 0..1 → 0..100
  let winContext: PitcherComponent;
  if (args.teamWinProbability != null) {
    winContext = {
      value: Math.round(clamp(args.teamWinProbability * 100)),
      source: "environment",
      reason: `team win ${(args.teamWinProbability * 100).toFixed(0)}%`,
    };
  } else {
    fallbacks.push("winContextScore");
    winContext = { value: 50, source: "fallback" };
  }

  return {
    components: {
      strikeoutScore,
      contactSuppressionScore,
      commandScore,
      runPreventionScore: runPrevention,
      workloadScore: workload,
      winContextScore: winContext,
    },
    fallbacks,
  };
}

export function describePitcherComponents(build: PitcherComponentsBuild): string {
  const c = build.components;
  const order: Array<[string, PitcherComponent, number]> = [
    ["K", c.strikeoutScore, 0.25],
    ["Contact", c.contactSuppressionScore, 0.20],
    ["Command", c.commandScore, 0.15],
    ["Run prev", c.runPreventionScore, 0.20],
    ["Workload", c.workloadScore, 0.10],
    ["Win ctx", c.winContextScore, 0.10],
  ];
  return order
    .map(([label, comp, w]) => `${label} ${comp.value}${comp.source === "fallback" ? "·fb" : ""} (×${w})`)
    .join(" · ");
}
