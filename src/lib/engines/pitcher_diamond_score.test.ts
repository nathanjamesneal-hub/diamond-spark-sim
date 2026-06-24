import test from "node:test";
import assert from "node:assert/strict";
import {
  pitcherDiamondScore,
  buildPitcherComponents,
} from "./pitcher_diamond_score.ts";
import { project as projectAlpha } from "./alpha_0_3/engine.ts";
import type { MonteCarloGameEnvironment } from "../game-environment.ts";

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

const pitcherDna = {
  contact: 45, power: 55, speed: 35, discipline: 60, consistency: 65,
};

test("elite strikeout pitcher scores higher than neutral pitcher", () => {
  const neutral = pitcherDiamondScore({});
  const elite = pitcherDiamondScore({ strikeoutScore: 95 });
  assert.ok(elite > neutral, `expected elite (${elite}) > neutral (${neutral})`);
});

test("missing inputs fall back to neutral 50 without crashing", () => {
  const score = pitcherDiamondScore({});
  assert.equal(score, 50);

  const build = buildPitcherComponents({});
  assert.equal(build.components.strikeoutScore.value, 50);
  assert.equal(build.components.strikeoutScore.source, "fallback");
  assert.ok(build.fallbacks.includes("strikeoutScore"));
  assert.ok(build.fallbacks.includes("winContextScore"));
});

test("high run environment lowers pitcher Diamond Score", () => {
  const friendly = projectAlpha({
    dna: pitcherDna,
    pitcherQuality: 55,
    role: "pitcher",
    teamSide: "home",
    gameEnvironment: {
      ...baseEnvironment,
      homeWinProbability: 0.55,
      awayWinProbability: 0.45,
      projectedAwayTeamRuns: 3.0,
      runEnvironmentRating: 35,
    },
  });
  const harsh = projectAlpha({
    dna: pitcherDna,
    pitcherQuality: 55,
    role: "pitcher",
    teamSide: "home",
    gameEnvironment: {
      ...baseEnvironment,
      homeWinProbability: 0.55,
      awayWinProbability: 0.45,
      projectedAwayTeamRuns: 6.0,
      runEnvironmentRating: 80,
    },
  });
  assert.ok(
    friendly.diamond_score > harsh.diamond_score,
    `friendly env diamond ${friendly.diamond_score} should beat harsh ${harsh.diamond_score}`,
  );
});

test("higher Monte Carlo win probability improves pitcher win context", () => {
  const lowWin = projectAlpha({
    dna: pitcherDna,
    pitcherQuality: 55,
    role: "pitcher",
    teamSide: "home",
    gameEnvironment: {
      ...baseEnvironment,
      homeWinProbability: 0.35,
      awayWinProbability: 0.65,
    },
  });
  const highWin = projectAlpha({
    dna: pitcherDna,
    pitcherQuality: 55,
    role: "pitcher",
    teamSide: "home",
    gameEnvironment: {
      ...baseEnvironment,
      homeWinProbability: 0.7,
      awayWinProbability: 0.3,
    },
  });
  const lowInputs = lowWin.inputs as unknown as {
    pitcher_components: { winContextScore: { value: number } };
  };
  const highInputs = highWin.inputs as unknown as {
    pitcher_components: { winContextScore: { value: number } };
  };
  assert.ok(
    highInputs.pitcher_components.winContextScore.value >
      lowInputs.pitcher_components.winContextScore.value,
  );
  assert.ok(highWin.diamond_score > lowWin.diamond_score);
});
