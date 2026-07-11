import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkLegEligibility,
  pickBestBetAndFeatured,
  assembleTicket,
  RECOMMENDATION_THRESHOLDS,
  type LegCandidateInput,
} from "../eligibility";

const base: LegCandidateInput = {
  runStatus: "completed",
  engineStatus: "validated",
  simCount: 5000,
  stderr: 0.4,
  projectionStage: "final_pregame",
  projectionCompletedAt: new Date().toISOString(),
  playerInLineup: true,
  isStartingPitcher: false,
  gameStarted: false,
  newerSimPending: false,
  supportedMarket: true,
  hasMarketPrice: true,
  diamondProbability: 0.62,
  edgePp: 6,
  score: 70,
  requiresMarketEdge: true,
};

describe("eligibility", () => {
  it("passes a full candidate", () => {
    assert.deepEqual(checkLegEligibility(base), { ok: true });
  });

  it("rejects scaffold engine", () => {
    assert.deepEqual(
      checkLegEligibility({ ...base, engineStatus: "scaffold_unvalidated" }),
      { ok: false, reason: "engine_not_validated" },
    );
  });

  it("rejects when player not in lineup and not a starter", () => {
    assert.deepEqual(
      checkLegEligibility({ ...base, playerInLineup: false, isStartingPitcher: false }),
      { ok: false, reason: "player_not_in_lineup" },
    );
  });

  it("rejects started games", () => {
    assert.deepEqual(
      checkLegEligibility({ ...base, gameStarted: true }),
      { ok: false, reason: "game_started" },
    );
  });

  it("rejects when newer sim is pending", () => {
    assert.deepEqual(
      checkLegEligibility({ ...base, newerSimPending: true }),
      { ok: false, reason: "newer_sim_pending" },
    );
  });

  it("rejects when market edge required but no price", () => {
    assert.deepEqual(
      checkLegEligibility({ ...base, hasMarketPrice: false }),
      { ok: false, reason: "no_market_price" },
    );
  });

  it("rejects probability below threshold", () => {
    assert.deepEqual(
      checkLegEligibility({ ...base, diamondProbability: 0.4 }),
      { ok: false, reason: "probability_below_threshold" },
    );
  });

  it("rejects negative edge when edge required", () => {
    assert.deepEqual(
      checkLegEligibility({ ...base, edgePp: -2 }),
      { ok: false, reason: "no_positive_edge" },
    );
  });

  it("rejects uncertainty too high", () => {
    assert.deepEqual(
      checkLegEligibility({ ...base, stderr: 1.1 }),
      { ok: false, reason: "uncertainty_too_high" },
    );
  });

  it("rejects score below threshold even with good probability", () => {
    assert.deepEqual(
      checkLegEligibility({ ...base, score: 40 }),
      { ok: false, reason: "score_below_threshold" },
    );
  });
});

describe("pickBestBetAndFeatured", () => {
  it("picks best bet only when high enough", () => {
    const eligible = [
      { score: 82, probability: 0.65 },
      { score: 78, probability: 0.62 },
      { score: 74, probability: 0.60 },
    ];
    const { bestBet, featured } = pickBestBetAndFeatured(eligible, 5);
    assert.equal(bestBet?.score, 82);
    assert.equal(featured.length, 2);
  });
  it("no best bet when top isn't strong enough", () => {
    const eligible = [{ score: 60, probability: 0.55 }];
    const { bestBet, featured } = pickBestBetAndFeatured(eligible, 5);
    assert.equal(bestBet, null);
    assert.equal(featured.length, 1);
  });
});

describe("assembleTicket", () => {
  const p = (i: number) => ({ playerId: `p${i}`, gameId: `g${i}`, probability: 0.62, score: 70 });
  it("builds a 2-leg cross-game ticket", () => {
    const t = assembleTicket([p(1), p(2), p(3)], 2);
    assert.equal(t?.length, 2);
    assert.notEqual(t![0].gameId, t![1].gameId);
  });
  it("rejects duplicate players", () => {
    const dup = { playerId: "p1", gameId: "g2", probability: 0.62, score: 70 };
    const t = assembleTicket([p(1), dup, p(3)], 2);
    assert.notEqual(t![0].playerId, t![1].playerId);
  });
  it("returns null when not enough qualifying legs", () => {
    assert.equal(assembleTicket([p(1)], 2), null);
  });
  it("higher-upside allows lower probability legs", () => {
    const legs = [
      { playerId: "a", gameId: "g1", probability: 0.53, score: 60 },
      { playerId: "b", gameId: "g2", probability: 0.54, score: 60 },
      { playerId: "c", gameId: "g3", probability: 0.55, score: 60 },
    ];
    const strict = assembleTicket(legs, 3);
    assert.equal(strict, null);
    const relaxed = assembleTicket(legs, 3, {
      minProb: RECOMMENDATION_THRESHOLDS.HIGHER_UPSIDE_MIN_LEG_PROB,
      minScore: RECOMMENDATION_THRESHOLDS.HIGHER_UPSIDE_MIN_LEG_SCORE,
    });
    assert.equal(relaxed?.length, 3);
  });
});
