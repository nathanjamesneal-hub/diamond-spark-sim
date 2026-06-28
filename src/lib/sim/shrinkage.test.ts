import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  shrinkHitterCounts,
  shrinkPitcherCounts,
  HITTER_FULL_TRUST_PA,
  PITCHER_FULL_TRUST_BF,
} from "./shrinkage.ts";
import { LEAGUE } from "./league.ts";

describe("hitter shrinkage", () => {
  it("regresses an extreme tiny-sample HR rate materially toward league", () => {
    // 30 PA, 5 HR ⇒ raw HR rate 0.167 (vs league 0.030). Absurd.
    const out = shrinkHitterCounts({
      pa: 30, K: 6, BB: 2, HBP: 0, HR: 5, H_1B: 4, H_2B: 1, H_3B: 0,
    });
    const hr = out.diagnostics.perOutcome.HR;
    assert.equal(hr.rawRate, 5 / 30);
    // Must move far from raw, well toward league.
    assert.ok(hr.shrunkRate < 0.07, `HR shrunk rate ${hr.shrunkRate} should be < 0.07`);
    assert.ok(hr.shrunkRate > LEAGUE.HR, "shrunk rate should remain above league prior");
    assert.ok(out.diagnostics.shrinkageWeight > 0.8, "small sample → heavy shrinkage");
  });

  it("leaves a full-sample hitter (>= FULL_TRUST_PA) effectively unchanged", () => {
    const pa = HITTER_FULL_TRUST_PA + 50;
    const HR = Math.round(0.05 * pa); // good but realistic HR/PA
    const out = shrinkHitterCounts({
      pa, K: Math.round(0.22 * pa), BB: Math.round(0.09 * pa), HBP: 3,
      HR, H_1B: Math.round(0.14 * pa), H_2B: Math.round(0.045 * pa), H_3B: 1,
    });
    const hr = out.diagnostics.perOutcome.HR;
    assert.equal(out.diagnostics.shrinkageWeight, 0, "full sample → zero shrinkage weight");
    assert.equal(hr.shrunkCount, HR);
  });

  it("never lets event counts exceed sample PA", () => {
    const out = shrinkHitterCounts({
      pa: 10, K: 4, BB: 2, HBP: 0, HR: 3, H_1B: 1, H_2B: 0, H_3B: 0,
    });
    const total = out.K + out.BB + out.HBP + out.HR + out.H_1B + out.H_2B + out.H_3B;
    assert.ok(total <= 10, `total events ${total} must be <= pa 10`);
  });
});

describe("pitcher shrinkage", () => {
  it("regresses tiny-BF pitcher rates toward league", () => {
    // 40 BF, 20 K, 6 BB ⇒ wildly inflated.
    const out = shrinkPitcherCounts({
      bf: 40, K: 20, BB: 6, HBP: 1, HR: 4, H_1B: 6, H_2B: 2, H_3B: 0,
    });
    const k = out.diagnostics.perOutcome.K;
    assert.ok(k.shrunkRate < 0.32, `K shrunk rate ${k.shrunkRate} should be < 0.32`);
    assert.ok(out.diagnostics.shrinkageWeight > 0.85, "small BF → heavy shrinkage");
  });

  it("leaves a full-sample pitcher (>= FULL_TRUST_BF) effectively unchanged", () => {
    const bf = PITCHER_FULL_TRUST_BF + 50;
    const K = Math.round(0.26 * bf);
    const out = shrinkPitcherCounts({
      bf, K, BB: Math.round(0.08 * bf), HBP: 4, HR: Math.round(0.03 * bf),
      H_1B: Math.round(0.14 * bf), H_2B: Math.round(0.045 * bf), H_3B: 1,
    });
    assert.equal(out.diagnostics.shrinkageWeight, 0);
    assert.equal(out.diagnostics.perOutcome.K.shrunkCount, K);
  });
});
