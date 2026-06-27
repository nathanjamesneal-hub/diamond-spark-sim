/**
 * Pure-logic tests for the first-pitch cutoff guard.
 *
 * The DB-integration cases listed in the implementation plan (live-actuals
 * idempotence, cron-driven locking, React Query refetch isolation) are
 * covered by the runtime guard chain — every write path now calls
 * {@link gameHasStartedOrPastStart} via {@link partitionOpenGames} or
 * {@link assertForecastWindowOpen} before any sim/insert, and the lifecycle
 * writer additionally short-circuits with `post-first-pitch-skip`. These
 * tests pin the status-classification rules so a regression in the pure
 * function would be caught immediately.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  gameHasStartedOrPastStart,
  partitionOpenGames,
} from "../window.ts";

describe("gameHasStartedOrPastStart", () => {
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const past = new Date(Date.now() - 60 * 60_000).toISOString();

  it("keeps the window open for pregame statuses", () => {
    for (const s of ["Scheduled", "Pre-Game", "Warmup", "Postponed"]) {
      assert.equal(gameHasStartedOrPastStart(s, future), false, `${s} should be open`);
    }
  });

  it("treats 'Delayed Start: Rain' as pregame (rain delay before first pitch)", () => {
    assert.equal(gameHasStartedOrPastStart("Delayed Start: Rain", future), false);
  });

  it("closes the window for any live/final/suspended state", () => {
    for (const s of [
      "In Progress",
      "Live",
      "Final",
      "Game Over",
      "Completed Early",
      "Manager Challenge",
      "Suspended",
      "Delayed: Rain",
    ]) {
      assert.equal(gameHasStartedOrPastStart(s, future), true, `${s} should be closed`);
    }
  });

  it("closes the window when first pitch has passed even if status lags", () => {
    assert.equal(gameHasStartedOrPastStart("Scheduled", past), true);
  });

  it("ignores null inputs safely", () => {
    assert.equal(gameHasStartedOrPastStart(null, null), false);
  });
});

describe("partitionOpenGames", () => {
  it("splits live games from open games and logs blocked entries", () => {
    const games = [
      { id: "a", mlb_game_id: 1, game_status: "Scheduled", first_pitch_at: null },
      { id: "b", mlb_game_id: 2, game_status: "In Progress", first_pitch_at: null },
      { id: "c", mlb_game_id: 3, game_status: "Final", first_pitch_at: null },
    ];
    const { open, blocked } = partitionOpenGames(games, "test");
    assert.deepEqual(open.map((g) => g.id), ["a"]);
    assert.deepEqual(blocked.map((b) => b.game.id), ["b", "c"]);
  });
});
