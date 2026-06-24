import test from "node:test";
import assert from "node:assert/strict";
import {
  projectForModelVersion,
  resolveModelVersion,
} from "./registry.ts";
import { MODEL_VERSION as ALPHA_0_3_VERSION } from "./alpha_0_3/engine.ts";
import { MODEL_VERSION as V0_1_0_VERSION } from "./v0_1_0/engine.ts";

const input = {
  dna: { contact: 55, power: 60, speed: 50, discipline: 50, consistency: 58 },
  pitcherQuality: 50,
  battingOrder: 4,
  teamSide: "home" as const,
};

test("resolveModelVersion uses explicit version before active database version", () => {
  assert.equal(resolveModelVersion(ALPHA_0_3_VERSION, V0_1_0_VERSION), V0_1_0_VERSION);
});

test("resolveModelVersion uses active database version when explicit version is absent", () => {
  assert.equal(resolveModelVersion(ALPHA_0_3_VERSION), ALPHA_0_3_VERSION);
});

test("resolveModelVersion falls back to v0.1.0 when no version is active", () => {
  assert.equal(resolveModelVersion(null), V0_1_0_VERSION);
});

test("projectForModelVersion preserves v0.1.0 behavior without Alpha-only outputs", () => {
  const out = projectForModelVersion(V0_1_0_VERSION, input);
  assert.equal(out.model_version, V0_1_0_VERSION);
  assert.equal(out.run_probability, null);
  assert.equal(out.pitcher_win_probability, null);
  assert.equal(out.quality_start_probability, null);
});

test("projectForModelVersion enables Alpha 0.3 outputs for Alpha version", () => {
  const out = projectForModelVersion(ALPHA_0_3_VERSION, {
    ...input,
    gameEnvironment: {
      source: "monte-carlo",
      gamePk: 1,
      iterations: 2000,
      generatedAt: "2026-06-23T00:00:00.000Z",
      projectedHomeTeamRuns: 5.8,
      projectedAwayTeamRuns: 4.2,
      homeWinProbability: 0.61,
      awayWinProbability: 0.39,
      teamTotalDistribution: { home: [], away: [], total: [] },
      runEnvironmentRating: 66,
      nrfiProbability: 0.41,
      yrfiProbability: 0.59,
    },
  });
  assert.equal(out.model_version, ALPHA_0_3_VERSION);
  assert.equal(typeof out.run_probability, "number");
});

