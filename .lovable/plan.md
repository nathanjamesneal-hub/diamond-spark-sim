## Why the board is empty today

DB snapshot (2026-06-27):
- `forecast_runs`: 5 `preview/published`, 0 `official` of any status.
- `projections`: 320 active `preview` rows, 0 active `official`.

Every public read path hard-filters `projection_class = 'official'`. With no officials today, all surfaces collapse to empty even though preview snapshots exist with Monte Carlo distributions.

No engine math, lifecycle writes, snapshot generation, calibration, Diamond Score, or Consensus formulas change. Only the read layer and labeling.

## 1. Shared best-available selector

New module `src/lib/forecast/select-public.ts` — pure, no DB I/O.

Selector identity (corrected): `(game_id, player_id, role, market, model_version)`.
- `role` ∈ `hitter | pitcher`
- `market` is supplied by the caller (Forecast Board cycles per active market; Sim Leaders/Top Props/Consensus iterate over the market set). A player's Hit / TB / HR / RBI rows never collapse.

Priority — pick exactly one per key, drop the rest:
1. `projection_class='official'` + `forecast_runs.status='locked'`
2. `projection_class='official'` + `forecast_runs.status='published'`
3. `projection_class='preview'`  + `forecast_runs.status='published'` AND `!gameHasStartedOrPastStart(game)`
4. nothing → excluded

Authoritative start state: import the shared `gameHasStartedOrPastStart` / `assertForecastWindowOpen` from `src/lib/forecast/window.ts`. Previews are eligible for any game whose forecast window is open (delayed-before-first-pitch ✅, in-progress/final/post-first-pitch ❌). Once a game has actually started, previews drop permanently.

Active public model-version gate (corrected): before the selector runs, callers filter rows to `model_version === activeVersion` from `model_versions WHERE active = true`. Shadow versions never appear on Forecast Board, Top Props, Sim Leaders, or Consensus — only Admin / Projection Lab with explicit version selector.

Tagging on the surviving row (corrected — keep fields orthogonal):
- `projection_class`: `'preview' | 'official'` (passed through unchanged)
- `forecast_run_status`: `'published' | 'locked' | 'superseded'` (passed through unchanged)
- `game_display_state`: `'upcoming' | 'live' | 'final' | 'other'` (existing)
- `display_state` (NEW, UI-only): `'preview' | 'published' | 'locked' | 'live' | 'final'`
- `display_label` (NEW, UI-only):
  - preview → `Monte Carlo preview — projected lineups, not an official Diamond forecast`
  - official + published → `Lineup-confirmed Monte Carlo forecast`
  - official + locked / live / final → `Locked Monte Carlo forecast — original projection preserved`
- `lineup_completeness?: { confirmed: number; expected: number }` (from `game_lineup_status`)

No new `forecast_status='preview'` value. The existing `ForecastBoardStatus` is renamed to `display_state` end-to-end.

## 2. Wire the selector into read paths

Each path widens its SQL filter to `projection_class IN ('official','preview')` and `forecast_runs.status IN ('published','locked')` (still excludes `superseded`), filters to active model version, then pipes through `selectBestAvailable()`:

- `src/lib/projections.functions.ts` → `getDiamondScores` (powers Forecast Board, Diamond Scores, Top Props, Today Top Forecasts; Sim Leaders consumes its payload).
- `src/lib/sim.functions.ts` → `getSimulationLeaders` today path (`forecast_player_projections` + `forecast_runs.status IN ('published','locked')`, both classes, then selector).
- `getPlayerProjection` history list stays official-only (trusted history).

## 3. Monte Carlo snapshot visibility (preview AND official)

The persisted snapshot is the single source of truth — **never re-run Monte Carlo on read**.

- Hitters: snapshot in `projections.sim_snapshot.distributions[{H,HR,TB,RBI,SB,R,BB,K,PA}]` with `{mean, p10, p50, p90, prob_over[]}`.
- Pitchers: same shape for `{K,BB,ER,H,OUTS,BF}` plus `quality_start_probability`, `pitcher_win_probability`.
- Today's live path also reads `forecast_player_projections.distributions` — same selector applies.

Cards already returned by `getDiamondScores` extended (no recompute):
- `hit_mean`, `hr_mean`, `tb_mean`, `rbi_mean`, plus per-market `*_p10/p50/p90` and `*_event_probability` (e.g. `hit_1plus_prob`, `hr_1plus_prob`, `tb_2plus_prob`).
- `projected_pa` for hitters when present in snapshot; `projected_bf` and `projected_outs` for pitchers.
- `simulation_iterations` and `simulation_seed` are returned but tagged admin-only.

### Forecast Board compact row
- `Prob` column: market-specific MC event probability from snapshot.
- `Mean` column: market-specific MC projected mean from snapshot.
- Hitter rows show `PA`; pitcher rows show `BF / Outs` context.
- Amber `Preview` badge in the status column whenever `display_state==='preview'`; existing badge logic otherwise.

### Forecast Detail Drawer (read-only)
- Monte Carlo projected mean
- P10 / P50 / P90 for the selected market
- Event probability (P(Hit 1+), P(HR 1+), P(TB 2+), etc.)
- Projected PA / BF / Outs
- `simulation_iterations` + `simulation_seed` rendered only inside the Admin advanced section (`hasRole('admin')`)
- Drawer never triggers a sim; reads `sim_snapshot` only.

### Consensus
- Keep visible columns: Monte Carlo mean, Monte Carlo probability.
- Preview-sourced rows carry an amber `Preview Alignment` label.
- Official rows carry their existing official/locked label.
- Sort and weights unchanged.

### Top page banner
On `/diamond-scores` and `/` Today section, only when visible slice contains any preview rows: amber strip explaining preview vs official.

## 4. Forecast Board UI controls

`src/components/diamond/forecast-board/forecast-board.tsx`:
- Accepted display states: `['published','locked','live','final','preview']`.
- New filter: `All available | Official only | Preview only` (default `All available`).
- Empty state only when zero rows survive after selector + filter. With preview rows present, board renders them with amber badges — no empty state.

## 5. Trusted paths stay official-locked only

No change to: `model-results.functions.ts`, `/results`, `/model`, `/calibration`, live grading, `projection_results` joins, `calibration_summary`. Each `eq('projection_class','official')` gets a one-line comment "trusted-path filter, do not widen". Only official locked Monte Carlo outputs are eligible for projected-vs-actual comparison.

## 6. Verification after build (values returned in chat)

Server-side audit for active slate date:
- `previewActiveCount` — selector outputs where `display_state === 'preview'`.
- `officialActiveCount` — selector outputs where `display_state ∈ {published, locked, live, final}`.
- `boardRowCount` — rows the board renders with default `All available` filter.
- `duplicateKeyCount` — count of `(game_id, player_id, role, market, model_version)` with more than one row after selector. MUST be 0.
- Sample A: preview row currently shown for a pregame game with no official forecast (proves preview shows pre-publication).
- Sample B: a game with both `preview` published AND `official` published — confirm only the official is in selector output (proves official replaces preview).
- Sample C: a game with `official locked` AND a newer `preview published` for same key — confirm locked official wins (proves locked permanence).
- Confirmation message: "No `projections.*`, `forecast_runs.*`, or `sim_snapshot` data was written, updated, regenerated, or deleted by this change. No Monte Carlo simulation was executed."

## Acceptance

- ~320 preview-backed rows render today with amber `Monte Carlo preview — projected lineups…` labels.
- Zero duplicate preview + official rows for the same `(game, player, role, market, model_version)`.
- Publishing one official forecast for a game removes its preview rows from every public surface (Board, Top Props, Sim Leaders, Consensus, Today).
- Locked official remains selected even when newer preview data exists.
- Once a game has actually started (per `gameHasStartedOrPastStart`), previews drop immediately and permanently; delayed-before-first-pitch games keep showing previews.
- Future shadow model versions never leak into public surfaces.
- Results, Model, Calibration, trusted audits remain byte-identical: official-only, locked snapshots only.
- No migrations, no schema changes, no engine/lifecycle/sim edits.
