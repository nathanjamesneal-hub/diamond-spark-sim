
No — I was switched to plan mode before any edits ran. Nothing in the codebase or database has been changed yet. Here is the plan I want to execute.

## Current state (verified read-only)

- `publishOfficialForecast` server fn already exists and wraps `runDiamondEngineForGames(..., 'official')`, which already enforces eligibility, first-pitch cutoff, snapshot persistence, supersede semantics, and `publishForecastIfEligible` per game.
- `runRefresh` (called by admin + pg_cron `refresh-lineups-window-a/b` every 15 min) only re-runs the engine for games whose **lineups or starters changed in that cycle**. It does not reconcile games that became eligible in a previous cycle but never got an official forecast written.
- `lock-live-forecasts` cron already runs every minute and locks active official forecasts at first pitch.
- DB confirms HOU@DET (824257) and NYY@BOS (824745) for 2026-06-27 each have: 2 confirmed SPs, 9-deep home + away confirmed lineups, `Pre-Game` status, 0 active official projections, ~25 active preview rows. They are the gap.

## Goal

1. Publish official forecasts for the two eligible-but-unpublished games right now using the existing eligibility-gated lifecycle (no math, calibration, or UI changes).
2. Make the 15-minute refresh job self-healing so this gap cannot reopen: any pregame, eligible game lacking an active official forecast is auto-published on the next cycle.

## Plan

### 1. Add a publication-gap reconciliation pass to `runRefresh`

In `src/lib/lineups/refresh.functions.ts`, after step 4 (cutoff filter) and before the early-return in step 5:

- Load all today's pregame, non-locked games on `date`.
- For each, evaluate `evaluateOfficialEligibility` against current `lineups` + `starting_pitchers` + `game_lineup_status`.
- For every eligible game that has no row in `forecast_runs` with `status IN ('published','locked')` for the active `model_version` and `projection_class='official'`, add its game id to `summary.changedGameIds` (deduped).
- Tag these in the log as `reason: "publication_gap_reconciliation"` so cron history shows why a "no-change" cycle still ran the engine.

The existing eligibility gate inside `runDiamondEngineForGames` will still be the source of truth — reconciliation only widens the candidate set; it cannot bypass eligibility, the first-pitch cutoff, the locked-skip rule, or the same-input-hash no-op in `publishForecastIfEligible`.

No changes to model math, Diamond Score, Consensus, calibration, UI, or preview rows. Preview rows remain `preview` and admin-only; reconciliation only writes `official`.

### 2. Trigger one refresh cycle immediately

After the edit deploys, POST to `/api/public/hooks/refresh-lineups` with the `CRON_WEBHOOK_SECRET`. The new reconciliation pass will detect 824257 and 824745, run the engine for those two game ids only with `intendedClass='official'`, and `publishForecastIfEligible` will create exactly one official `forecast_runs` row each.

### 3. Verify

Return the requested verification table from a read query:

```text
gamePk | matchup | eligible | official_run_id | projection_class | status | generated_at | version_number | preview_count | public_visible
```

Then re-run the focused pre-slate integrity check for only these two games:

- official forecasts exist with `projection_class='official'`, `status='published'`, alpha-0.3, version_number ≥ 1
- existing `preview_active` projection rows are unchanged and still admin-only
- public Forecast Board / Consensus / Projection Lab now show official rows for both games
- no public read route invoked the simulator or any writer

## Out of scope for this turn

The broader automation spec (auto-lock telemetry table, per-game admin status panel additions, the manual "Run Lineup Refresh Now" button if not already present, the full test suite covering supersede / live-lock / window-closed cases) lands in a follow-up turn so this fix can ship before today's first pitch. The two pieces above are the minimum required to clear the gap and prevent it from recurring on the existing 15-minute schedule.

## Technical notes

Files touched:
- `src/lib/lineups/refresh.functions.ts` — add reconciliation pass between current steps 4 and 5; extend `RefreshSummary` with a `publicationGapGameIds: string[]` field for observability.

Files read-only:
- `src/lib/ingest.functions.ts` (`runDiamondEngineForGames`, `publishOfficialForecast`)
- `src/lib/forecast/lifecycle.ts` (`publishForecastIfEligible`)
- `src/lib/forecast/eligibility.ts` (`evaluateOfficialEligibility`)
- `src/lib/forecast/window.ts` (`partitionOpenGames`, `gameHasStartedOrPastStart`)

No migrations, no new tables, no schema changes, no secret changes.
