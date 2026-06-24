import type { MonteCarloGameEnvironment } from "@/lib/game-environment";
import type { SimResult } from "./engine";

const NEUTRAL_TOTAL_RUNS = 8.6;

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

export function runEnvironmentRating(meanTotalRuns: number): number {
  return Math.round(clamp(50 + (meanTotalRuns - NEUTRAL_TOTAL_RUNS) * 10));
}

export function toMonteCarloGameEnvironment(
  gamePk: number,
  result: SimResult,
  generatedAt = new Date().toISOString(),
): MonteCarloGameEnvironment {
  return {
    source: "monte-carlo",
    gamePk,
    iterations: result.iterations,
    generatedAt,
    projectedHomeTeamRuns: result.meanHomeRuns,
    projectedAwayTeamRuns: result.meanAwayRuns,
    homeWinProbability: result.homeWinProb,
    awayWinProbability: result.awayWinProb,
    teamTotalDistribution: {
      home: result.homeRunsDist,
      away: result.awayRunsDist,
      total: result.totalDist,
    },
    runEnvironmentRating: runEnvironmentRating(result.meanTotal),
    nrfiProbability: result.nrfi,
    yrfiProbability: result.yrfi,
    starterPitcherDistributions: {
      home: result.homePitcher,
      away: result.awayPitcher,
    },
  };
}
