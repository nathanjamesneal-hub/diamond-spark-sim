# Force Run Diamond Engine — Admin Button

A manual fallback that bypasses the normal "skip if already projected" guards and runs the Diamond Engine against every game on today's slate, even when lineups are partial.

## What it does

One click triggers a server function that:
1. Reads today's date in Chicago timezone (`todayInAppTz()`).
2. Loads every game scheduled for that date from the `games` table (any status: Scheduled, Pre-Game, Warmup, In Progress, Live, Final).
3. For each game, gathers all available `lineups` rows + `starting_pitchers` rows — does NOT require a full 9-batter lineup. Games with zero players are skipped and reported.
4. Runs Diamond Engine for every eligible player (hitters via existing engine, pitchers via `pitcher_diamond_score`), forcing recompute (ignores "already has projection today" short-circuit).
5. Upserts results into `projections`, superseding prior rows for the same player/game/date.
6. Returns a structured report: games found, games processed, games skipped (with reasons), hitter predictions generated, pitcher predictions generated, errors per game.

## UI

In `src/routes/_authenticated/_admin/admin.tsx`, add a new card next to "Update Today's Slate":

- **Title**: "Force Run Diamond Engine"
- **Subtitle**: "Backup trigger — recomputes projections for every game on today's slate, even with partial lineups."
- Button with loading spinner.
- On success, render a result panel with:
  - Games found / processed / skipped
  - Hitter predictions generated
  - Pitcher predictions generated
  - Per-game breakdown (collapsible) with any errors
- Toast on completion; invalidates the `diamond-scores` and `lineup-status` query keys so cards refresh.

## Technical changes

- **`src/lib/ingest.functions.ts`**: add `forceRunDiamondEngine` server fn (auth + admin role check). Reuses `runDiamondEngineForGames` internals but passes a `force: true` flag that bypasses the existing-projection skip. If `runDiamondEngineForGames` doesn't already accept a force flag, add one (default `false`) so existing callers are unchanged.
- **`src/routes/_authenticated/_admin/admin.tsx`**: new card + `useMutation` wired to the server fn, result display, query invalidation.

No schema changes. No changes to engine math, hitter formula, pitcher formula, or auto-trigger pipeline.
