# Preview Projections — Implementation Plan

Goal: Diamond runs pregame Monte Carlo previews from projected lineups + probable starters, persists them as `projection_class='preview'` forecast runs, and keeps them strictly out of Results / Model / public Forecast Board. The existing official lifecycle is untouched.

Most of the lifecycle plumbing already exists (`forecast_runs.projection_class`, `publishForecastIfEligible` with `forecastClass: "preview"`, `official-exists-preview-blocked` guard, first-pitch cutoff). The work is wiring it up end-to-end and surfacing it in the UI.

## 1. Preview-class resolver (new: `src/lib/forecast/resolve-preview.ts`)

Sibling to `resolve.ts`. Same `simulateAndBuild` callback, but:

- Builds lineups from **any** lineup rows (projected + confirmed), not just confirmed.
- Falls back to probable starter rows (`confirmed=false` allowed) when confirmed SP missing.
- Requires the same minimum to sim (both SPs known, both lineups 9-deep — projected or confirmed).
- Computes a **separate preview input hash** by including a `previewSourceMix` field in `MaterialInputs.parkFactors`-like sidecar so a confirmed-lineup change produces a different hash than the projected version. (Implemented as a `previewInputs` discriminator merged into `candidateInputs.gameEnvironment`.)
- Calls `publishForecastIfEligible(..., { forecastClass: 'preview' })`.

Lineup-source metadata captured into `material_inputs.preview_meta`:

```
{ lineup_source: 'projected'|'partial'|'confirmed',
  home_lineup_count, away_lineup_count,
  starter_confidence: 'confirmed'|'probable'|'mixed',
  input_completeness: 0..1 }
```

## 2. Orchestrator preview pass (`src/lib/automation/orchestrator.ts`)

After step 1 (refresh) and before step 2 (lock), add:

```text
3) For each pregame, non-locked, not-started game on `date`
   that has NO active official forecast and ≥ minimum preview inputs:
       resolveAndPublishPreview(game)
   Same-hash no-op handled by publishForecastIfEligible.
```

Counts surface in `OrchestrateResult.preview = { evaluated, published, noop, blocked, error }` and `automation_log.details.preview`. Never runs once `gameHasStartedOrPastStart(...)` is true (the lifecycle's `post-first-pitch-skip` is the backstop).

## 3. Refresh pipeline — leave official path alone

`runRefresh` keeps publishing **official** only. No preview side-effects, no preview supersede. (Previews are owned by the orchestrator preview pass — same module, separate write path.)

## 4. Reads

New read: `src/lib/forecasts/preview.functions.ts` → `getPreviewForecasts(date)`. Member-gated. Joins `forecast_runs` where `projection_class='preview'`, `status='published'`, with player projections + preview_meta. Used only by the new UI tab.

All existing reads (`getDiamondScores`, Consensus v1/v2, Results, Model, Calibration, Top Forecasts, public board) already filter to `projection_class='official'` (or to `projections.projection_class='official'`); audit each to make doubly sure and add explicit filters where implicit.

## 5. UI — Early Slate · Preview Projections

New route `src/routes/_authenticated/forecasts/early-slate.tsx`. Linked from Forecasts nav as a separate tab.

- Amber banner: "Preview — projected lineups, not an official Diamond forecast."
- Per-game card: projected means, MC probabilities, Diamond Score, projected lineup status, starter status, generated_at, input completeness chip.
- Public Forecast Board, `/results`, `/calibration-lab`, `/forecasts/consensus`, `/odds`, "/" home: no preview rows.

## 6. Tests (`src/lib/forecast/__tests__/preview.test.ts`)

Pure-function tests using a fake `LifecycleContext.admin`:

1. Projected-only inputs → `published` preview run, hash recorded.
2. Same projected inputs replayed → `noop`.
3. Confirmed lineups arrive → resolver builds official, `publishForecastIfEligible` returns `published` for 'official'; a follow-up preview call returns `official-exists-preview-blocked`.
4. Preview write after first-pitch → `post-first-pitch-skip`; no projection rows written.
5. `runDiamondEngineForGames(..., 'preview')` cannot mutate an active official row (separate class filter).
6. Results / Model / Consensus selectors filter out `projection_class='preview'` (selector unit test).

## Out of scope

- No new tables, no schema migration (uses existing `projection_class`).
- No change to Diamond Engine math, calibration, or Monte Carlo math.
- No change to official locking, official supersede, or first-pitch guard.

## Files touched

- New: `src/lib/forecast/resolve-preview.ts`, `src/lib/forecasts/preview.functions.ts`, `src/routes/_authenticated/forecasts/early-slate.tsx`, `src/lib/forecast/__tests__/preview.test.ts`.
- Edit: `src/lib/automation/orchestrator.ts` (preview pass + telemetry), nav link in forecasts layout, defensive `projection_class='official'` filter audit in read paths.

Approve and I'll implement.
