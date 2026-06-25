# Fix: one-click MLB slate + Diamond Engine pipeline

## What's broken (verified against DB + MLB API)

- MLB API has **9 games for today (2026-06-25 CT)**. DB has **0 games** for that date.
- Latest 8 `cron_runs` for today all report **"No lineup changes detected"** — because the refresh runner **calls `aggregateLineups` first, which queries `games` for the date and finds none**. The refresh never imports the schedule, so it can never bootstrap a new day.
- The admin panel has **9 separate buttons** (schedule → SP → refresh → lineups → DNA → engine → lock → results → calibration). There is no single "Update Today's Slate" action.
- Admin date input defaults to `new Date().toISOString().slice(0,10)` (UTC), which can differ from the Chicago calendar day the rest of the app uses.
- Yesterday "worked" because by the evening the schedule had already been imported and lineups were drifting in, so the refresh loop had something to aggregate.

## Plan

### 1. New single server fn `runDailyPipeline(date)`

In `src/lib/ingest.functions.ts`. Admin-gated. Runs the full sequence and returns a structured debug payload:

```ts
{
  ok, date,
  schedule:   { games_upserted, teams_upserted, error? },
  pitchers:   { sp_upserted, error? },
  lineups:    { lineup_rows, players_upserted, games_with_confirmed, error? },
  refresh:    { providers, changed_game_ids, players_changed, pitchers_changed },
  engine:     { games_processed, projections_inserted, environment_failures },
  cards:      { hitters, pitchers, games_with_projections, games_pending },
}
```

Sequence:

1. `importSchedule({date})` — upsert teams + games (Scheduled, Pre-Game, Warmup, Live, Final all included; existing code already does this).
2. `importStartingPitchers({date})` — upserts probables.
3. `importLineups({date})` — confirmed MLB lineups when available (no-op for games without batting orders, doesn't fail the run).
4. `runRefresh(date)` — providers + diff (will now find games, since step 1 imported them).
5. **Always** call `runDiamondEngineForGames(date)` for every game with a lineup OR a probable pitcher, regardless of whether refresh reported changes. This is the regression fix: yesterday's path always ran the engine; the new incremental refresh skipped it when `changedGameIds` was empty.
6. Read back counts of hitter/pitcher projections for the response.

### 2. Admin UI changes (`src/routes/_authenticated/_admin/admin.tsx`)

- Add a prominent **"Update Today's Slate"** button at the top that calls `runDailyPipeline({date})`.
- Default the date picker to `todayInAppTz()` (Chicago) instead of UTC.
- Render the structured debug payload underneath: counts per step, errors per step, list of changed game IDs, and any provider errors. Keep the existing 9 step-buttons below for power users.

### 3. Lineup status visibility (no schema changes)

`getTodaysSlate` and `/lineup-status` already compute per-game status from existing fields (`game_status`, lineup row count, projection presence). After the pipeline runs, every game shows one of: `probable pitchers loaded` / `lineup pending` / `confirmed lineup loaded` / `live` / `final`. Just confirm the labels render — no DB work needed.

### 4. Player card "Needs Engine Run" affordance (`src/routes/diamond-scores.tsx`)

- When a game appears in the slate but has no projection row for the active model version, render a "Needs engine run" badge with a button that calls `runDiamondEngineForGames(date, [gameId])` (new tiny admin wrapper).
- Invalidate the diamond-scores query on success so cards refresh.

### 5. Upsert / matching audit (read-only confirmation, no rewrites)

Existing writes already use the correct patterns — no change needed, just documenting so the user can see it:

- `games` upsert: `onConflict: "mlb_game_id"` ✓
- `players` upsert: `onConflict: "mlb_id"` ✓
- `lineups` upsert: `onConflict: "game_id,player_id"` ✓
- `starting_pitchers` upsert: `onConflict: "game_id,team_id"` ✓
- `projections` insert with `projection_status` superseding ✓

Name-fallback player matching is not added — every MLB endpoint we hit (`/schedule`, `/boxscore`) returns `mlb_id`, so name-only matching would be dead code.

### 6. No schema migration required

All needed columns already exist. The fix is entirely in server-fn orchestration + admin UI.

## Files touched

- `src/lib/ingest.functions.ts` — add `runDailyPipeline` server fn + small `runEngineForGame` wrapper.
- `src/routes/_authenticated/_admin/admin.tsx` — add top-of-page "Update Today's Slate" button, debug panel, fix default date to Chicago.
- `src/routes/diamond-scores.tsx` — "Needs engine run" badge + per-game retry button on cards missing projections.

## Verification

After the user clicks "Update Today's Slate":
- DB query: `SELECT date, COUNT(*) FROM games GROUP BY date` shows today's 9 games.
- DB query: projections for today have non-default `diamond_score` spread.
- Admin debug panel shows non-zero counts per step or specific error messages.
- `/diamond-scores` and `/slate` populate with cards.
