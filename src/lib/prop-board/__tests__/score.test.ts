import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreCandidate, normalizeWithinMarket, type ScoreInputs, MARKET_PROB_THRESHOLDS } from "../score";

const base: ScoreInputs = {
  market: "1plus_hit",
  eventProbability: 0.75,
  projectedMean: 1.1,
  threshold: 0.5,
  simCount: 5000,
  stderr: 0.05,
  confidence: 0.75,
  formDirection: "stable",
  formProbAdjustment: 0.0,
  formSampleSize: 10,
  formReliability: 0.6,
  matchupGrade: 60,
  lineupStatus: "confirmed",
  projectionStage: "lineup_confirmed",
  newerSimPending: false,
  ageMinutes: 15,
  engineStatus: "validated",
  hasMarketPrice: false,
  noVigMarketProb: null,
};

describe("prop-board scoreCandidate", () => {
  it("probability is the strongest input", () => {
    const strong = scoreCandidate({ ...base, eventProbability: 0.85 });
    const weak   = scoreCandidate({ ...base, eventProbability: 0.35 });
    assert.ok(strong.score > weak.score + 15, `expected big gap, got ${strong.score} vs ${weak.score}`);
  });

  it("high recent form does NOT overpower weak MC probability", () => {
    const hotButWeakProb = scoreCandidate({
      ...base,
      eventProbability: 0.30,
      formDirection: "rising",
      formReliability: 1,
      formSampleSize: 30,
    });
    const solid = scoreCandidate({ ...base, eventProbability: 0.72, formDirection: "stable" });
    assert.ok(solid.score > hotButWeakProb.score, "solid MC should beat hot-but-weak-MC");
  });

  it("negative recent form reduces but does not exclude a strong MC play", () => {
    const clean = scoreCandidate({ ...base, eventProbability: 0.82 });
    const negForm = scoreCandidate({
      ...base,
      eventProbability: 0.82,
      formDirection: "falling",
      formReliability: 0.7,
      formSampleSize: 15,
    });
    assert.ok(negForm.score < clean.score, "negative form should lower score");
    assert.notEqual(negForm.tier, "excluded", "negative form alone should not exclude");
    assert.ok(negForm.reasons.includes("negative_recent_form"));
  });

  it("tiny hot streak is regressed toward baseline (small sample)", () => {
    const tinyHot = scoreCandidate({
      ...base,
      formDirection: "rising",
      formReliability: 0.95,
      formSampleSize: 2, // tiny
    });
    const bigHot = scoreCandidate({
      ...base,
      formDirection: "rising",
      formReliability: 0.95,
      formSampleSize: 25,
    });
    assert.ok(bigHot.components.form > tinyHot.components.form, "small sample must regress toward baseline");
    assert.ok(tinyHot.reasons.includes("small_form_sample"));
  });

  it("high mean but weak threshold probability ranks below strong probability", () => {
    // Realistic HR-market pairing: high-mean lineup slot with weak clear-prob
    // (mean 0.35 but prob 0.10) versus a solid-prob slot (prob 0.28, mean 0.30).
    const highMeanWeakProb = scoreCandidate({
      ...base,
      market: "hr",
      eventProbability: 0.10,
      projectedMean: 0.35,
      threshold: null,
    });
    const solidHrProb = scoreCandidate({
      ...base,
      market: "hr",
      eventProbability: 0.28,
      projectedMean: 0.30,
      threshold: null,
    });
    assert.ok(solidHrProb.score > highMeanWeakProb.score,
      `expected solid prob to win, got ${solidHrProb.score} vs ${highMeanWeakProb.score}`);
  });

  it("high uncertainty flags a warning reason and knocks off heavy tier", () => {
    const s = scoreCandidate({ ...base, stderr: 0.9, projectedMean: 1.0 });
    assert.ok(s.reasons.includes("high_uncertainty"));
    assert.notEqual(s.tier, "heavy", "high uncertainty should not be heavy");
  });

  it("projected lineup applies opportunity penalty and warning", () => {
    const conf = scoreCandidate({ ...base, lineupStatus: "confirmed" });
    const proj = scoreCandidate({ ...base, lineupStatus: "projected" });
    assert.ok(conf.components.opportunity > proj.components.opportunity);
    assert.ok(conf.score > proj.score);
    assert.ok(proj.reasons.includes("projected_lineup"));
  });

  it("confirmed lineup enables heavy tier when other signals qualify", () => {
    const heavyish = scoreCandidate({
      ...base,
      eventProbability: 0.86,
      matchupGrade: 70,
      formDirection: "stable",
      formReliability: 0.7,
      formSampleSize: 20,
    });
    assert.equal(heavyish.tier, "heavy");
  });

  it("missing matchup redistributes weight to probability/mean/opportunity", () => {
    const withMatchup = scoreCandidate({ ...base, matchupGrade: 55 });
    const noMatchup   = scoreCandidate({ ...base, matchupGrade: null });
    assert.equal(withMatchup.weightsApplied.matchup, 0.05);
    assert.equal(noMatchup.weightsApplied.matchup, 0);
    assert.ok(noMatchup.weightsApplied.probability > withMatchup.weightsApplied.probability);
    assert.ok(noMatchup.reasons.includes("matchup_unavailable"));
    // Total weight must still sum to 1.
    const sum = Object.values(noMatchup.weightsApplied).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it("no sportsbook price runs in model_only mode with model weights", () => {
    const s = scoreCandidate({ ...base, hasMarketPrice: false });
    assert.equal(s.mode, "model_only");
    assert.equal(s.weightsApplied.marketEdge, 0);
    assert.ok(s.reasons.includes("model_only_no_price"));
  });

  it("real sportsbook price enables edge scoring in market_compared mode", () => {
    const s = scoreCandidate({
      ...base,
      hasMarketPrice: true,
      noVigMarketProb: 0.65,
      eventProbability: 0.75,
    });
    assert.equal(s.mode, "market_compared");
    assert.ok(s.weightsApplied.marketEdge > 0);
    assert.ok((s.components.marketEdge ?? 0) > 0.5, "positive edge should exceed 0.5");
  });

  it("market-specific probability thresholds keep HR separate from Hit", () => {
    // 0.20 is heavy for HR but far below watchlist for 1+ Hit.
    const hrHeavy = scoreCandidate({
      ...base,
      market: "hr",
      eventProbability: 0.30,
      projectedMean: 0.5,
      threshold: null,
    });
    const hitBadProb = scoreCandidate({ ...base, market: "1plus_hit", eventProbability: 0.30 });
    assert.notEqual(hrHeavy.tier, "excluded");
    assert.equal(hitBadProb.tier, "excluded");
  });

  it("stale output is excluded", () => {
    const s = scoreCandidate({ ...base, ageMinutes: 500 });
    assert.equal(s.tier, "excluded");
    assert.ok(s.reasons.includes("stale_output"));
  });

  it("newer_sim_pending excludes the row", () => {
    const s = scoreCandidate({ ...base, newerSimPending: true });
    assert.equal(s.tier, "excluded");
    assert.ok(s.reasons.includes("newer_sim_pending"));
  });

  it("scaffold_unvalidated forces preview tier, not heavy/strong", () => {
    const s = scoreCandidate({ ...base, engineStatus: "scaffold_unvalidated", eventProbability: 0.9 });
    assert.equal(s.tier, "preview");
    assert.ok(s.reasons.includes("preview_engine_unvalidated"));
  });

  it("normalizeWithinMarket caps to 100 at the max", () => {
    const rows = [{ score: 40 }, { score: 60 }, { score: 80 }];
    const out = normalizeWithinMarket(rows);
    assert.equal(out[2].score, 100);
    assert.ok(out[0].score < out[1].score && out[1].score < out[2].score);
  });

  it("market thresholds are sane and monotonic", () => {
    for (const [, t] of Object.entries(MARKET_PROB_THRESHOLDS)) {
      assert.ok(t.heavy > t.strong);
      assert.ok(t.strong > t.watchlist);
      assert.ok(t.watchlist > 0);
    }
  });
});
