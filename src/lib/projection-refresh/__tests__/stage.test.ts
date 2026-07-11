import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveProjectionStage,
  deriveGameLifecycleStatus,
  summarizeChangeReason,
} from "../stage.ts";

test("early projection when starters ready but lineups only projected and no prior run", () => {
  assert.equal(
    deriveProjectionStage({
      startersReady: true,
      lineupsProjected: true,
      lineupsConfirmed: false,
      minutesToFirstPitch: 720,
      hadPriorCurrent: false,
    }),
    "early",
  );
});

test("null stage when no probable pitcher", () => {
  assert.equal(
    deriveProjectionStage({
      startersReady: false,
      lineupsProjected: false,
      lineupsConfirmed: false,
      minutesToFirstPitch: 900,
      hadPriorCurrent: false,
    }),
    null,
  );
});

test("updated when starters ready, no confirmation, and a prior current exists", () => {
  assert.equal(
    deriveProjectionStage({
      startersReady: true,
      lineupsProjected: true,
      lineupsConfirmed: false,
      minutesToFirstPitch: 240,
      hadPriorCurrent: true,
    }),
    "updated",
  );
});

test("lineup_confirmed when confirmed lineups arrive well before first pitch", () => {
  assert.equal(
    deriveProjectionStage({
      startersReady: true,
      lineupsProjected: true,
      lineupsConfirmed: true,
      minutesToFirstPitch: 90,
      hadPriorCurrent: true,
    }),
    "lineup_confirmed",
  );
});

test("final_pregame inside cutoff with confirmed lineups", () => {
  assert.equal(
    deriveProjectionStage({
      startersReady: true,
      lineupsProjected: true,
      lineupsConfirmed: true,
      minutesToFirstPitch: 5,
      hadPriorCurrent: true,
    }),
    "final_pregame",
  );
});

test("lifecycle status: awaiting probable pitchers", () => {
  const r = deriveGameLifecycleStatus({
    gameStatus: "Scheduled",
    startersReady: false,
    lineupsProjected: false,
    lineupsConfirmed: false,
    minutesToFirstPitch: 1200,
  });
  assert.equal(r.status, "awaiting_probable_pitchers");
});

test("lifecycle status: postponed short-circuits", () => {
  const r = deriveGameLifecycleStatus({
    gameStatus: "Postponed",
    startersReady: true,
    lineupsProjected: true,
    lineupsConfirmed: true,
    minutesToFirstPitch: 60,
  });
  assert.equal(r.status, "postponed");
});

test("lifecycle status: game started blocks further projections", () => {
  const r = deriveGameLifecycleStatus({
    gameStatus: "In Progress",
    startersReady: true,
    lineupsProjected: true,
    lineupsConfirmed: true,
    minutesToFirstPitch: -10,
  });
  assert.equal(r.status, "game_started");
});

test("summarizeChangeReason: first projection", () => {
  assert.equal(
    summarizeChangeReason({ prevHash: null, nextHash: "abc123" }),
    "first projection for this game",
  );
});

test("summarizeChangeReason: reasons composed from flags", () => {
  const r = summarizeChangeReason({
    prevHash: "deadbeefdeadbeef",
    nextHash: "cafebabecafebabe",
    flags: { batting_order_change: true, lineup_confirmed: true },
  });
  assert.match(r, /lineup confirmed/);
  assert.match(r, /batting order/);
});

test("summarizeChangeReason: falls back to hash diff when no flags", () => {
  const r = summarizeChangeReason({
    prevHash: "aaaaaaaaaaaaaaaa",
    nextHash: "bbbbbbbbbbbbbbbb",
  });
  assert.match(r, /inputs_hash changed/);
});
