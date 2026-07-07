import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyGameState, pregameSnapshotAllowed } from "../game-state";

describe("classifyGameState", () => {
  const NOW = Date.parse("2026-07-06T22:00:00Z");
  const FIRST_PITCH_FUTURE = "2026-07-06T22:10:00Z";
  const FIRST_PITCH_PAST = "2026-07-06T21:50:00Z";

  it("confirmed live status → ACTUALLY_STARTED", () => {
    assert.equal(classifyGameState({ game_status: "In Progress" }, NOW), "ACTUALLY_STARTED");
    assert.equal(classifyGameState({ game_status: "Live" }, NOW), "ACTUALLY_STARTED");
    assert.equal(classifyGameState({ game_status: "Final" }, NOW), "ACTUALLY_STARTED");
  });

  it("actual_start_at in the past → ACTUALLY_STARTED", () => {
    assert.equal(
      classifyGameState({ game_status: "Scheduled", actual_start_at: "2026-07-06T21:55:00Z" }, NOW),
      "ACTUALLY_STARTED",
    );
  });

  it("pregame Delayed Start → PRE_GAME_DELAYED (not started)", () => {
    assert.equal(classifyGameState({ game_status: "Delayed Start: Rain" }, NOW), "PRE_GAME_DELAYED");
    assert.equal(classifyGameState({ game_status: "Delayed Start" }, NOW), "PRE_GAME_DELAYED");
  });

  it("postponed / suspended distinct", () => {
    assert.equal(classifyGameState({ game_status: "Postponed" }, NOW), "POSTPONED_OR_SUSPENDED");
    assert.equal(classifyGameState({ game_status: "Suspended" }, NOW), "POSTPONED_OR_SUSPENDED");
  });

  it("scheduled / pre-game → NOT_STARTED", () => {
    assert.equal(classifyGameState({ game_status: "Scheduled" }, NOW), "NOT_STARTED");
    assert.equal(classifyGameState({ game_status: "Pre-Game" }, NOW), "NOT_STARTED");
    assert.equal(classifyGameState({ game_status: "Warmup" }, NOW), "NOT_STARTED");
    assert.equal(classifyGameState({ game_status: null }, NOW), "NOT_STARTED");
  });

  it("MIL @ STL regression: snapshot before scheduled first pitch + 'Delayed Start' is NOT missed_pregame", () => {
    const snapshotCreatedAt = Date.parse("2026-07-06T22:03:00Z");
    const cls = classifyGameState(
      { game_status: "Delayed Start", actual_start_at: null, scheduled_first_pitch: FIRST_PITCH_FUTURE },
      snapshotCreatedAt,
    );
    assert.equal(cls, "PRE_GAME_DELAYED");
    assert.equal(
      pregameSnapshotAllowed(
        { game_status: "Delayed Start", actual_start_at: null, scheduled_first_pitch: FIRST_PITCH_FUTURE },
        snapshotCreatedAt,
      ),
      true,
    );
  });

  it("in-game 'Delayed' (not 'Delayed Start') → ACTUALLY_STARTED", () => {
    assert.equal(classifyGameState({ game_status: "Delayed: Rain" }, NOW), "ACTUALLY_STARTED");
  });

  it("pregameSnapshotAllowed blocks ACTUALLY_STARTED and POSTPONED", () => {
    assert.equal(pregameSnapshotAllowed({ game_status: "In Progress" }, NOW), false);
    assert.equal(pregameSnapshotAllowed({ game_status: "Postponed" }, NOW), false);
    assert.equal(pregameSnapshotAllowed({ game_status: "Scheduled" }, NOW), true);
    assert.equal(pregameSnapshotAllowed({ game_status: "Delayed Start" }, NOW), true);
  });

  it("firstPitchPast alone (with Scheduled status) does not force ACTUALLY_STARTED", () => {
    assert.equal(
      classifyGameState({ game_status: "Scheduled", scheduled_first_pitch: FIRST_PITCH_PAST }, NOW),
      "NOT_STARTED",
    );
  });
});
