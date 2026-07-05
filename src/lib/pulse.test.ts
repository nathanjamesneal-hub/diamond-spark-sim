import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPulseLineupState,
  lineupLabelForSource,
  normalizePulseGameStatus,
} from "./pulse.ts";

test("normalizes MLB game statuses for Pulse", () => {
  assert.equal(normalizePulseGameStatus("Scheduled"), "upcoming");
  assert.equal(normalizePulseGameStatus("Pre-Game"), "upcoming");
  assert.equal(normalizePulseGameStatus("In Progress"), "live");
  assert.equal(normalizePulseGameStatus("Manager challenge"), "live");
  assert.equal(normalizePulseGameStatus("Final"), "final");
  assert.equal(normalizePulseGameStatus("Delayed Start"), "delayed");
  assert.equal(normalizePulseGameStatus("Postponed"), "postponed");
  assert.equal(normalizePulseGameStatus(null), "unavailable");
});

test("only MLB confirmed lineups can be labeled official", () => {
  assert.equal(lineupLabelForSource("mlb", true), "Official");
  assert.equal(lineupLabelForSource("mlb", false), "Unavailable");
  assert.equal(lineupLabelForSource("rotowire", true), "Unavailable");
  assert.equal(lineupLabelForSource("diamond_projection", true), "Projected from prior lineup");
});

test("non-official lineup states do not expose a verified timestamp", () => {
  const official = buildPulseLineupState({
    source: "mlb",
    confirmed: true,
    lastVerifiedAt: "2026-07-05T18:00:00.000Z",
  });
  assert.equal(official.label, "Official");
  assert.equal(official.lastVerifiedAt, "2026-07-05T18:00:00.000Z");

  const fallback = buildPulseLineupState({
    source: "diamond_projection",
    confirmed: true,
    lastVerifiedAt: "2026-07-05T18:00:00.000Z",
  });
  assert.equal(fallback.label, "Projected from prior lineup");
  assert.equal(fallback.lastVerifiedAt, null);
});
