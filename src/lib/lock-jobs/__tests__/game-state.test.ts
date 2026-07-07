import { describe, it, expect } from "vitest";
import { classifyGameState, pregameSnapshotAllowed } from "../game-state";

describe("classifyGameState", () => {
  const NOW = Date.parse("2026-07-06T22:00:00Z");
  const FIRST_PITCH_FUTURE = "2026-07-06T22:10:00Z";
  const FIRST_PITCH_PAST = "2026-07-06T21:50:00Z";

  it("classifies confirmed live status as ACTUALLY_STARTED", () => {
    expect(classifyGameState({ game_status: "In Progress" }, NOW)).toBe("ACTUALLY_STARTED");
    expect(classifyGameState({ game_status: "Live" }, NOW)).toBe("ACTUALLY_STARTED");
    expect(classifyGameState({ game_status: "Final" }, NOW)).toBe("ACTUALLY_STARTED");
  });

  it("uses actual_start_at when present and past", () => {
    expect(
      classifyGameState({ game_status: "Scheduled", actual_start_at: "2026-07-06T21:55:00Z" }, NOW),
    ).toBe("ACTUALLY_STARTED");
  });

  it("classifies pregame Delayed Start as PRE_GAME_DELAYED (NOT started)", () => {
    expect(classifyGameState({ game_status: "Delayed Start: Rain" }, NOW)).toBe("PRE_GAME_DELAYED");
    expect(classifyGameState({ game_status: "Delayed Start" }, NOW)).toBe("PRE_GAME_DELAYED");
  });

  it("classifies postponed / suspended distinctly", () => {
    expect(classifyGameState({ game_status: "Postponed" }, NOW)).toBe("POSTPONED_OR_SUSPENDED");
    expect(classifyGameState({ game_status: "Suspended" }, NOW)).toBe("POSTPONED_OR_SUSPENDED");
  });

  it("classifies scheduled / pre-game as NOT_STARTED", () => {
    expect(classifyGameState({ game_status: "Scheduled" }, NOW)).toBe("NOT_STARTED");
    expect(classifyGameState({ game_status: "Pre-Game" }, NOW)).toBe("NOT_STARTED");
    expect(classifyGameState({ game_status: "Warmup" }, NOW)).toBe("NOT_STARTED");
    expect(classifyGameState({ game_status: null }, NOW)).toBe("NOT_STARTED");
  });

  it("MIL @ STL regression: a snapshot created before scheduled first pitch with 'Delayed Start' status is NOT considered started", () => {
    // The scenario: at snapshot creation time (before scheduled first pitch),
    // MLB status was "Delayed Start". The old broad regex treated this as
    // started and labeled the pregame snapshot missed_pregame_window.
    const snapshotCreatedAt = Date.parse("2026-07-06T22:03:00Z"); // 7 min before scheduled first pitch
    const cls = classifyGameState(
      {
        game_status: "Delayed Start",
        actual_start_at: null,
        scheduled_first_pitch: FIRST_PITCH_FUTURE,
      },
      snapshotCreatedAt,
    );
    expect(cls).toBe("PRE_GAME_DELAYED");
    expect(pregameSnapshotAllowed(
      { game_status: "Delayed Start", actual_start_at: null, scheduled_first_pitch: FIRST_PITCH_FUTURE },
      snapshotCreatedAt,
    )).toBe(true);
  });

  it("in-game 'Delayed' (not 'Delayed Start') is treated as ACTUALLY_STARTED", () => {
    expect(classifyGameState({ game_status: "Delayed: Rain" }, NOW)).toBe("ACTUALLY_STARTED");
  });

  it("pregameSnapshotAllowed blocks ACTUALLY_STARTED and POSTPONED_OR_SUSPENDED", () => {
    expect(pregameSnapshotAllowed({ game_status: "In Progress" }, NOW)).toBe(false);
    expect(pregameSnapshotAllowed({ game_status: "Postponed" }, NOW)).toBe(false);
    expect(pregameSnapshotAllowed({ game_status: "Scheduled" }, NOW)).toBe(true);
    expect(pregameSnapshotAllowed({ game_status: "Delayed Start" }, NOW)).toBe(true);
  });

  it("firstPitchPast alone is not enough to force ACTUALLY_STARTED (status/actual are authoritative)", () => {
    // The classifier deliberately does NOT infer 'started' purely from
    // scheduled_first_pitch — an unrefreshed MLB status shouldn't override
    // reality. The lock scheduler enforces hard_stop_at separately.
    expect(
      classifyGameState({ game_status: "Scheduled", scheduled_first_pitch: FIRST_PITCH_PAST }, NOW),
    ).toBe("NOT_STARTED");
  });
});
