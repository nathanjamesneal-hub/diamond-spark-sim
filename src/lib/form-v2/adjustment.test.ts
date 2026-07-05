import test from "node:test";
import assert from "node:assert/strict";
import {
  adjustBatterProfileForRecentForm,
  adjustPitcherProfileForRecentForm,
  type RecentEventCounts,
} from "./adjustment.ts";
import type { BatterProfile, PitcherProfile } from "../sim/engine.ts";

const batter: BatterProfile = {
  id: 1,
  name: "Test Hitter",
  pa: 200,
  K: 40,
  BB: 20,
  HBP: 2,
  HR: 8,
  H_1B: 40,
  H_2B: 12,
  H_3B: 2,
};

const pitcher: PitcherProfile = {
  id: 2,
  name: "Test Pitcher",
  bf: 240,
  K: 60,
  BB: 24,
  HBP: 3,
  HR: 8,
  H_1B: 42,
  H_2B: 10,
  H_3B: 1,
  expectedIp: 5.5,
};

test("missing recent data leaves hitter profile unchanged", () => {
  const result = adjustBatterProfileForRecentForm(batter, null);
  assert.deepEqual(result.profile, batter);
  assert.equal(result.metadata.applied, false);
  assert.equal(result.metadata.reason, "missing recent counts");
});

test("small hitter samples do not adjust any event", () => {
  const recent: RecentEventCounts = {
    role: "hitter",
    mlb_id: 1,
    pa: 10,
    K: 10,
    BB: 0,
    HBP: 0,
    HR: 5,
    H_1B: 5,
    H_2B: 0,
    H_3B: 0,
  };
  const result = adjustBatterProfileForRecentForm(batter, recent);
  assert.deepEqual(result.profile, batter);
  assert.equal(result.metadata.applied, false);
  assert.equal(result.metadata.fields.every((f) => f.appliedDelta === 0), true);
});

test("hitter adjustments shrink toward baseline and respect caps", () => {
  const recent: RecentEventCounts = {
    role: "hitter",
    mlb_id: 1,
    pa: 60,
    K: 0,
    BB: 30,
    HBP: 5,
    HR: 20,
    H_1B: 45,
    H_2B: 20,
    H_3B: 10,
  };
  const result = adjustBatterProfileForRecentForm(batter, recent);
  assert.equal(result.metadata.applied, true);
  for (const field of result.metadata.fields) {
    assert.ok(Math.abs(field.appliedDelta) <= field.cap);
  }
  const hr = result.metadata.fields.find((f) => f.event === "HR");
  assert.equal(hr?.appliedDelta, 0.012);
});

test("missing pitcher hit-type counts leave those fields unchanged while eligible K can adjust", () => {
  const recent: RecentEventCounts = {
    role: "pitcher",
    mlb_id: 2,
    bf: 60,
    K: 30,
    BB: 3,
    HBP: 0,
    HR: 1,
    H_1B: null,
    H_2B: null,
    H_3B: null,
  };
  const result = adjustPitcherProfileForRecentForm(pitcher, recent);
  assert.equal(result.metadata.applied, true);
  assert.equal(result.metadata.fields.find((f) => f.event === "H_1B")?.status, "missing_recent_count");
  assert.equal(result.metadata.fields.find((f) => f.event === "K")?.status, "applied");
});

test("insufficient season baseline keeps pitcher unchanged", () => {
  const thin = { ...pitcher, bf: 20 };
  const recent: RecentEventCounts = {
    role: "pitcher",
    mlb_id: 2,
    bf: 80,
    K: 80,
    BB: 0,
    HBP: 0,
    HR: 0,
    H_1B: 0,
    H_2B: 0,
    H_3B: 0,
  };
  const result = adjustPitcherProfileForRecentForm(thin, recent);
  assert.deepEqual(result.profile, thin);
  assert.equal(result.metadata.reason, "season BF below 50");
});
