import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  americanToImplied,
  twoSidedNoVig,
  expectedValue,
  scoreRecommendation,
  estimatedCombinedProbability,
} from "../formulas";

describe("formulas / market math", () => {
  it("americanToImplied works both directions", () => {
    assert.ok(Math.abs(americanToImplied(-110)! - 0.5238) < 0.001);
    assert.ok(Math.abs(americanToImplied(+150)! - 0.4) < 0.001);
    assert.equal(americanToImplied(0), null);
  });

  it("twoSidedNoVig removes vig", () => {
    const p = twoSidedNoVig(-110, -110)!;
    assert.ok(Math.abs(p - 0.5) < 0.001);
  });

  it("expectedValue positive when model beats price", () => {
    const ev = expectedValue(0.6, -110)!;
    assert.ok(ev > 0);
  });
});

describe("formulas / recommendation score", () => {
  it("edge-plus-probability beats probability-only at same prob", () => {
    const withEdge = scoreRecommendation({
      diamondProbability: 0.6, novigProbability: 0.5, edgePp: 10,
      stderr: 0.3, confidence: 0.8, simCount: 5000,
      formDirection: "stable", formReliability: 0.5, matchupQuality: 0.5,
    });
    const noEdge = scoreRecommendation({
      diamondProbability: 0.6, novigProbability: null, edgePp: null,
      stderr: 0.3, confidence: 0.8, simCount: 5000,
      formDirection: "stable", formReliability: 0.5, matchupQuality: 0.5,
    });
    assert.equal(withEdge.probabilityOnly, false);
    assert.equal(noEdge.probabilityOnly, true);
  });

  it("form and matchup cannot push a play alone (weak prob stays weak)", () => {
    const weak = scoreRecommendation({
      diamondProbability: 0.4, novigProbability: null, edgePp: null,
      stderr: 0.1, confidence: 1, simCount: 100000,
      formDirection: "rising", formReliability: 1, matchupQuality: 1,
    });
    assert.ok(weak.score < 58, `weak play got ${weak.score}`);
  });

  it("uncertainty penalises high stderr", () => {
    const low = scoreRecommendation({
      diamondProbability: 0.62, novigProbability: 0.5, edgePp: 12,
      stderr: 0.1, confidence: 0.8, simCount: 5000,
      formDirection: "stable", formReliability: 0.5, matchupQuality: 0.5,
    });
    const high = { ...low };
    const highRes = scoreRecommendation({
      diamondProbability: 0.62, novigProbability: 0.5, edgePp: 12,
      stderr: 0.95, confidence: 0.8, simCount: 5000,
      formDirection: "stable", formReliability: 0.5, matchupQuality: 0.5,
    });
    void high;
    assert.ok(low.score > highRes.score);
  });
});

describe("formulas / combined ticket probability", () => {
  it("multiplies independent probabilities", () => {
    const p = estimatedCombinedProbability([0.6, 0.6])!;
    assert.ok(Math.abs(p - 0.36) < 1e-9);
  });
  it("null for empty", () => {
    assert.equal(estimatedCombinedProbability([]), null);
  });
  it("null for invalid input", () => {
    assert.equal(estimatedCombinedProbability([0.5, 1.5]), null);
  });
});
