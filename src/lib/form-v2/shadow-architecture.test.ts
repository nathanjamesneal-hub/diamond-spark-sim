import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("recent-event pipeline filters schedule games to final completed games", () => {
  const src = read("src/lib/form-v2/recent-events.ts");
  assert.match(src, /function finalGame/);
  assert.match(src, /\.filter\(finalGame\)/);
  assert.match(src, /feed\/live/);
  assert.match(src, /boxscore/);
});

test("shadow runner writes only to shadow tables, not public forecast tables", () => {
  const src = read("src/lib/form-v2/shadow.ts");
  assert.match(src, /monte_carlo_form_shadow_runs/);
  assert.match(src, /monte_carlo_form_shadow_player_outputs/);
  assert.doesNotMatch(src, /\.from\("projections"\)\s*\.(insert|upsert|update)/);
  assert.doesNotMatch(src, /\.from\("forecast_player_projections"\)\s*\.(insert|upsert|update)/);
});

test("shadow runner uses the baseline seed and fixed baseline iteration count", () => {
  const src = read("src/lib/form-v2/shadow.ts");
  assert.match(src, /simulation_seed/);
  assert.match(src, /const seed = Number\(run\.simulation_seed\)/);
  assert.match(src, /const SHADOW_ITERATIONS = 2000/);
});
