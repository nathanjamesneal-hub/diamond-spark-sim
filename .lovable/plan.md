## Problem

Players added to a lineup after first pitch (pinch hitters, defensive subs, mid-game pitching changes) have no pregame Monte Carlo snapshot. Our hard first-pitch cutoff (correctly) blocks any new projection writes for live/final games, so these players surface on the Forecast Board / Top Props / Consensus / Sim Leaders with blank Sim Mean cells and look like a data bug.

This is expected behavior, not a missing-data bug — but the UI doesn't say so, so it reads as broken.

## Fix (UI-only, no math or lifecycle changes)

Detect "post-lock roster additions" at read time and label them explicitly instead of rendering an empty mean.

### 1. Shared classifier — `src/lib/forecast/post-lock-addition.ts` (new)

A row is a `post_lock_addition` when ALL of the following are true:
- `game.status` is live / final / suspended-after-start (reuse `gameHasStartedOrPastStart`)
- The player appears in the current `lineups` row for that game
- `selectBestPublicForecast` returned `null` (no official + no locked preview snapshot for this player+role)

No new tables, no writes, no changes to `forecast_runs` / `projections` / `forecast_player_projections`.

### 2. Surfaces that show the badge

- **Forecast Board** (`src/components/forecast/forecast-row.tsx`): show a small amber/zinc "In-Game Add" pill in the Sim Mean cell and tooltip "Entered after first pitch — no pregame projection (cutoff locked)."
- **Forecast Detail Drawer** (`forecast-detail-drawer.tsx`): show the same note in the header area; hide the empty distribution panels.
- **Top Props** (`src/routes/_authenticated/top-props.tsx`): exclude post-lock additions from rankings (they have no mean to rank), and surface a small footer count: "N in-game additions hidden — added after first pitch."
- **Sim Leaders** (`/odds`) and **Diamond Consensus** (`/diamond-consensus`): same exclusion + same footer count.
- **Live Tracker** (`/today/live`): still show the player's live box-score stats; mark projection column as "—" with the same tooltip (do not grade them in Model Results — they're already excluded by snapshot-missing logic).

### 3. No engine / orchestrator changes

We do NOT attempt to project pinch hitters mid-game. The first-pitch lock and the "official forecast is immutable" rule both stay intact. We are only making the absence visible and intentional.

### Technical notes

- Single read-time helper keeps logic in one place; no duplication across five surfaces.
- Reuses existing `gameHasStartedOrPastStart` and `selectBestPublicForecast`; no new lifecycle states.
- No DB migration. No changes to Alpha math, Monte Carlo, calibration, or Results grading.
- Type: `{ isPostLockAddition: boolean; reason: 'no_pregame_snapshot' }` attached to the public row alongside existing fields.

## Out of scope

- Generating any kind of "rapid sim" for pinch hitters (would violate the hard cutoff rule you set).
- Backfilling projections for non-starters who weren't on the projected lineup.
- Any change to `forecast_status`, `display_state`, or grading.

Confirm and I'll implement.