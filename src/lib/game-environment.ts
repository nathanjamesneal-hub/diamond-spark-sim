export type TeamSide = "home" | "away";

export type RunDistributionPoint = {
  runs: number;
  pct: number;
};

export type MonteCarloStatDistribution = {
  playerId: number;
  name: string;
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  probAtLeast1: number;
  probAtLeast2: number;
};

export type StarterPitcherDistributions = {
  playerId: number;
  name: string;
  K: MonteCarloStatDistribution;
  BB: MonteCarloStatDistribution;
  ER: MonteCarloStatDistribution;
  H: MonteCarloStatDistribution;
  outs: MonteCarloStatDistribution;
};

export type MonteCarloGameEnvironment = {
  source: "monte-carlo";
  gamePk: number;
  iterations: number;
  generatedAt: string;
  projectedHomeTeamRuns: number;
  projectedAwayTeamRuns: number;
  homeWinProbability: number;
  awayWinProbability: number;
  teamTotalDistribution: {
    home: RunDistributionPoint[];
    away: RunDistributionPoint[];
    total: RunDistributionPoint[];
  };
  /** 0-100, where 50 is a neutral MLB run environment. */
  runEnvironmentRating: number;
  nrfiProbability: number;
  yrfiProbability: number;
  starterPitcherDistributions?: {
    home?: StarterPitcherDistributions;
    away?: StarterPitcherDistributions;
  };
};

export type GameEnvironmentInput = MonteCarloGameEnvironment | null | undefined;

export function teamRunsForEnvironment(
  environment: GameEnvironmentInput,
  teamSide: TeamSide,
): number | null {
  if (!environment) return null;
  return teamSide === "home"
    ? environment.projectedHomeTeamRuns
    : environment.projectedAwayTeamRuns;
}

export function opponentRunsForEnvironment(
  environment: GameEnvironmentInput,
  teamSide: TeamSide,
): number | null {
  if (!environment) return null;
  return teamSide === "home"
    ? environment.projectedAwayTeamRuns
    : environment.projectedHomeTeamRuns;
}

export function teamWinProbabilityForEnvironment(
  environment: GameEnvironmentInput,
  teamSide: TeamSide,
): number | null {
  if (!environment) return null;
  return teamSide === "home"
    ? environment.homeWinProbability
    : environment.awayWinProbability;
}

export function starterDistributionsForEnvironment(
  environment: GameEnvironmentInput,
  teamSide: TeamSide,
): StarterPitcherDistributions | null {
  if (!environment?.starterPitcherDistributions) return null;
  return environment.starterPitcherDistributions[teamSide] ?? null;
}
