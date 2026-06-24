## Goal

Make the projection pipeline observable, fix the empty `/slate` and `/diamond-scores` pages where the cause is display logic (it isn't today — the root cause is empty `lineups`/`projections` tables), and give per-game controls to push games through the pipeline. Do not change Diamond Engine hitter or Monte Carlo formulas. Do not remove cron, aggregation, or projection history.

## Diagnosis result (already gathered)

- 16 games today, 0 lineups today, 31 starting pitchers today, 411 player_dna rows, 0 projections today (active or otherwise).
- `getTodaysSlate` and `getDiamondScores` filter on `eq("date", date)`, `eq("projection_status", "active")`, and `model_versions.active=true` — all correct. Pages are empty purely because no `lineups` or `projections` rows exist for today. No RLS, date, or model-version bug to fix.
- Action implied: the new `/lineup-status` page must surface this clearly and give the admin per-game "Refresh lineups" / "Run engine" / "Lock" buttons to actually populate the data.

## New page: `/lineup-status`

Public route (read-only data + admin-gated action buttons), file `src/routes/lineup-status.tsx`.

### Top summary strip
- Games scheduled
- Games with lineups (≥1 lineup row)
- Games with confirmed lineups (`game_lineup_status.status='confirmed'` or `lineup_confidence>=95`)
- Games with starting pitchers (both sides)
- Games with active projections
- Games locked (`games.lineups_locked_at` not null)
- Last cron refresh (latest `cron_runs.finished_at`)
- Last engine run (latest `cron_runs` where `engine_ran=true`)

### Per-game table (one row per game on selected date)
Columns: Game (AWY @ HOM) · First pitch · Game status · Home lineup status · Away lineup status · Lineup source · Lineup confidence · Hitters set / 9 (per side) · SP status (home/away) · DNA status (n/9 hitters with non-default DNA) · Projection status · Latest projection run time · Model version · Locked · Last refresh.

### Badges
`Missing schedule`, `Missing pitchers`, `Missing lineups`, `Missing DNA`, `Ready to project`, `Projected`, `Confirmed`, `Locked`, `Projections available`, `No projections`. Pure presentational component in the route file.

### Per-game action buttons (admin only, hidden otherwise)
- Refresh lineups for this game
- Run Diamond Engine for this game
- Lock game

## Server functions (new, in `src/lib/lineup-status.functions.ts`)

Client-safe path (not under `src/server/`). All read functions use the publishable client; mutations use `requireSupabaseAuth` + `has_role('admin')` gate.

1. `getLineupStatus({ date? })` — public read. Joins for the page:
   - `games` for the date (+ teams).
   - `lineups` grouped by `(game_id, team_id)` → counts, `lineup_status`, `lineup_source`, max `locked_at`.
   - `starting_pitchers` per `(game_id, team_id)`.
   - `game_lineup_status` per game (confidence, hitters_set/expected, primary_source, last_refresh_at).
   - `projections` per game with `projection_status='active'`, latest `created_at` + `model_version`.
   - `player_dna` non-default count for the players appearing in today's lineups.
   - Latest `cron_runs` summary for the date.
   - Returns `{ date, summary, rows[] }`. Each row computes its badge set server-side (single source of truth).
2. `refreshLineupsForGame({ gameId })` — admin only. Calls `aggregateLineups(date)` then filters/applies only the affected game (we already fetch all games per date — cheap), refreshes pitchers/status for just that gamePk via the existing MLB schedule path, writes one `cron_runs` row with `affected_game_ids=[gameId]`. Does NOT trigger the engine.
3. `runEngineForGame({ gameId })` — admin only. Marks that game's active projections `superseded`, calls existing `runDiamondEngineForGames(date, [gameId])`, returns counts. No formula changes.
4. `lockGame({ gameId })` — admin only. Sets `games.lineups_locked_at = now()` and `lineups.locked_at = now()` for that game's rows.

All three mutations append a `cron_runs` audit row so the timeline stays complete.

## Pitcher card fallback (no formula changes)

`src/routes/diamond-scores.tsx` — pitcher card already shows `n/a` for unstored fields. Tighten the fallback labeling:
- Show the safe stored fields (Diamond Pitcher Score, `pitcher_win_probability`, `quality_start_probability`, `projected_outs`, `confidence`, `model_version`, lineup status/source/confidence) when a projection row exists.
- For K/ER/H/BB fields, render `Not available yet — field not persisted` (matches the requested copy) instead of bare `n/a`.
- When there's no projection row at all for a starting pitcher, render a "Pitcher projection pending" stub card (built from `starting_pitchers` + game/lineup info), with the same not-persisted labels for the unstored fields. Do not fabricate numbers.

## Admin: Pitching Engine Backlog note

In `src/routes/_authenticated/_admin/admin.tsx`, add a panel titled **Pitching Engine Backlog — fields not yet persisted** listing:
`k_projection`, `k_over_3_5_probability`, `k_over_4_5_probability`, `k_over_5_5_probability`, `k_over_6_5_probability`, `earned_runs_projection`, `er_under_2_5_probability`, `hits_allowed_projection`, `walks_projection`.

## `/slate` and `/diamond-scores` (no logic change required)

Confirmed the empty state is data, not query. Keep filters as-is. Add a one-line "No projections yet for {date}. See /lineup-status to push games through the pipeline." link to the empty state on both pages — purely presentational.

## Navigation

Add a "Lineup status" link to `src/components/site-header.tsx` (and the admin nav). Route is public; admin buttons are conditionally shown using the existing `has_role('admin')` check pattern.

## Out of scope (explicit)

- No changes to Diamond Engine hitter formulas.
- No changes to Monte Carlo formulas.
- No new persisted pitcher columns (backlog is documented in admin instead).
- No changes to cron schedule, aggregation, or projection history retention.
- No RLS changes (existing reads work, no policy was the cause).

## Files

New:
- `src/routes/lineup-status.tsx`
- `src/lib/lineup-status.functions.ts`

Edited:
- `src/routes/diamond-scores.tsx` (pitcher fallback labels + pending-pitcher stub)
- `src/routes/slate.tsx` (empty-state link)
- `src/routes/_authenticated/_admin/admin.tsx` (Pitching Engine Backlog panel)
- `src/components/site-header.tsx` (nav link)

## Validation

- `tsgo` passes.
- `/lineup-status` lists all 16 of today's games with badges and the live counts above.
- Clicking "Refresh lineups for this game" populates lineups for that game and the row updates.
- "Run Diamond Engine" then populates `/slate` and `/diamond-scores` for that game.
- `/admin` and Cron Status panel still render and refresh.
- Pitcher cards never show fabricated K/ER/H/BB values; they show the requested "Not available yet — field not persisted" text.
