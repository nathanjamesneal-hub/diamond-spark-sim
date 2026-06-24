import test from "node:test";
import assert from "node:assert/strict";
import { project } from "./engine.ts";
import { project as projectV010 } from "../v0_1_0/engine.ts";
import type { MonteCarloGameEnvironment } from "../../game-environment.ts";

const baseEnvironment: MonteCarloGameEnvironment = {
  source: "monte-carlo",
  gamePk: 1,
  iterations: 2000,
  generatedAt: "2026-06-23T00:00:00.000Z",
  projectedHomeTeamRuns: 4.3,
  projectedAwayTeamRuns: 4.3,
  homeWinProbability: 0.5,
  awayWinProbability: 0.5,
  teamTotalDistribution: { home: [], away: [], total: [] },
  runEnvironmentRating: 50,
  nrfiProbability: 0.48,
  yrfiProbability: 0.52,
};

const hitterInput = {
  dna: { contact: 58, power: 62, speed: 52, discipline: 55, consistency: 60 },
  pitcherQuality: 48,
  battingOrder: 4,
  teamSide: "home" as const,
};

test("hitter run and RBI projections rise in a higher Monte Carlo run environment", () => {
  const low = project({
    ...hitterInput,
    gameEnvironment: {
      ...baseEnvironment,
      projectedHomeTeamRuns: 3.1,
      projectedAwayTeamRuns: 3.4,
      runEnvironmentRating: 36,
    },
  });
  const high = project({
    ...hitterInput,
    gameEnvironment: {
      ...baseEnvironment,
      projectedHomeTeamRuns: 6.2,
      projectedAwayTeamRuns: 5.7,
      runEnvironmentRating: 75,
    },
  });

  assert.ok(high.rbi_probability! > low.rbi_probability!);
  assert.ok(high.run_probability! > low.run_probability!);
  assert.ok(high.diamond_score > low.diamond_score);
});

test("hitter projection falls back to neutral context when Monte Carlo environment is unavailable", () => {
  const base = projectV010(hitterInput);
  const alpha = project(hitterInput);

  assert.equal(alpha.diamond_score, base.diamond_score);
  assert.equal(alpha.rbi_probability, base.rbi_probability);
  assert.equal(alpha.confidence, base.confidence);
  assert.equal(alpha.environment_agreement, null);
  assert.equal(alpha.game_environment_inputs.projected_team_runs, null);
});

test("hitter confidence decreases when Diamond and Monte Carlo run context disagree", () => {
  const agreeing = project({
    ...hitterInput,
    gameEnvironment: {
      ...baseEnvironment,
      projectedHomeTeamRuns: 5.8,
      runEnvironmentRating: 70,
    },
  });
  const disagreeing = project({
    ...hitterInput,
    gameEnvironment: {
      ...baseEnvironment,
      projectedHomeTeamRuns: 2.8,
      runEnvironmentRating: 30,
    },
  });

  assert.ok(agreeing.environment_agreement! > disagreeing.environment_agreement!);
  assert.ok(agreeing.confidence > disagreeing.confidence);
});

test("pitcher projections use Monte Carlo win probability and run environment", () => {
  const friendly = project({
    dna: { contact: 45, power: 50, speed: 35, discipline: 55, consistency: 68 },
    pitcherQuality: 55,
    role: "pitcher",
    teamSide: "home",
    gameEnvironment: {
      ...baseEnvironment,
      homeWinProbability: 0.68,
      awayWinProbability: 0.32,
      projectedAwayTeamRuns: 2.9,
      runEnvironmentRating: 38,
    },
  });
  const harsh = project({
    dna: { contact: 45, power: 50, speed: 35, discipline: 55, consistency: 68 },
    pitcherQuality: 55,
    role: "pitcher",
    teamSide: "home",
    gameEnvironment: {
      ...baseEnvironment,
      homeWinProbability: 0.42,
      awayWinProbability: 0.58,
      projectedAwayTeamRuns: 6.1,
      runEnvironmentRating: 78,
    },
  });

  assert.ok(friendly.pitcher_win_probability! > harsh.pitcher_win_probability!);
  assert.ok(friendly.quality_start_probability! > harsh.quality_start_probability!);
  assert.ok(friendly.projected_outs! > harsh.projected_outs!);
});
