## Preview Projections — Pregame Automation

### Goal
Diamond runs early projected-lineup Monte Carlo previews before lineups confirm. Previews are clearly labeled, never lock, never grade, and never replace official forecasts. Confirmed lineups still publish a separate `official` snapshot through the existing pipeline.

### Already in place (verified)
- `projection_class = 'preview'` column exists on `projections` and is honored by `runDiamondEngineForGames` (`src/lib/ingest.functions.ts`).
- Lifecycle guards already block preview writes when an active `official` forecast exists, and block both classes after first pitch via `partitionOpenGames` (`src/lib/forecast/window.ts`).
- All public read paths (Forecast Board, Sim Leaders, Consensus, Results, Model Diagnostics, calibration) already filter `projection_class = 'official'`.

### What to build

1. **Preview lineup resolver** — new `src/lib/forecast/resolve-preview.ts`
   - Build a 9-deep batter set per side by merging confirmed → projected (Rotowire) → likely-starter fallbacks.
   - Resolve probable starters with a `starter_confidence` tag (`probable | likely | tbd`).
   - Compute `lineup_source` per side: `confirmed | partial | projected` and an `input_completeness` score.
   - Compute a dedicated `preview_input_hash` (independent of the official material hash) so projected-lineup updates create new preview versions without touching official versions.

2. **Orchestrator preview pass** — extend `src/lib/automation/orchestrator.ts`
   - New step between refresh and lock: `runPreviewPass(date)`.
   - For each pregame game with no active `official` forecast:
     - Resolve preview inputs; skip if `input_completeness` is below the minimum required to simulate (e.g. both starters known + ≥6 projected batters per side).
     - Compare `preview_input_hash` to the most recent stored preview; no-op when unchanged.
     - Call `runDiamondEngineForGames([gamePk], { intendedClass: 'preview' })`.
   - Skip silently if the game has started (`gameHasStartedOrPastStart`).
   - Log a single `automation_log` row per pass with counts (`candidate`, `regenerated`, `skipped_hash_match`, `skipped_window_closed`, `skipped_official_active`).

3. **Persist preview metadata** — extend the preview snapshot write in `ingest.functions.ts`
   - Store on the projection row's `sim_snapshot` (or new `preview_meta` JSON column if needed): `lineup_source_home`, `lineup_source_away`, `home_lineup_count`, `away_lineup_count`, `starter_confidence_home`, `starter_confidence_away`, `input_completeness`, `preview_input_hash`, `generated_at`.
   - Keep the existing snapshot fields (model version, seed, means, distributions, probabilities, Diamond Score, material inputs) identical to official runs.

4. **Official handoff (no change to mechanics, just verification)**
   - When confirmed lineups arrive, the existing `runRefresh` pass detects publication gaps and runs `intendedClass = 'official'` through `publishForecastIfEligible`. Preview rows remain untouched; they are never mutated into official.

5. **First-pitch enforcement (already present, add assertions)**
   - `partitionOpenGames` already blocks both classes once a game starts; add explicit test coverage (see Tests below).

6. **UI — Early Slate tab**
   - New route `src/routes/_authenticated/forecasts/early-slate.tsx` with amber preview banner.
   - New read fn `getEarlySlatePreviews(date)` in `src/lib/forecasts/preview.functions.ts` that selects only `projection_class = 'preview'` rows where the game is still pregame and no active official forecast exists.
   - Reuse the dense Forecast Board components, but render an amber "PREVIEW" badge in place of the official status pill and show: projected mean, sim probability, Diamond Score, lineup source per side, starter confidence, input completeness, generated timestamp.
   - Add an "Early Slate" tab to `src/components/forecasts-tab-bar.tsx`.
   - When a game has only previews and first pitch has passed without an official publication, render the empty-state copy: "No official pregame forecast published — projected-lineup preview was available but confirmed lineups did not publish in time."

7. **Audit existing read paths (read-only sweep)**
   - Confirm every consumer (`getDiamondScores`, `getSimulationLeaders`, `getForecastBoardDetail`, `getConsensus*`, Results, Model Diagnostics, calibration grader, Top Props) filters `projection_class = 'official'`. Add the filter explicitly anywhere it is implicit so previews can never leak in.

### Tests (`src/lib/forecast/__tests__/preview.test.ts`)
- Preview snapshot is created for a projected-lineup-only game pregame.
- Re-running with identical `preview_input_hash` is a no-op (no duplicate row/version).
- Confirmed lineups trigger a separate `official` row; the preview row is untouched.
- Attempting a preview write while an active `official` forecast exists is rejected.
- Preview and official writes are both rejected after `gameHasStartedOrPastStart === true`.
- Results/Model/Consensus query helpers exclude preview rows even when present in the table.

### Acceptance criteria
- Pregame slate auto-runs previews every orchestrator tick for games missing official forecasts.
- Previews stop generating at first pitch; official forecasts lock at first pitch.
- Previews never appear in Results, Model, calibration, public Consensus, official Top Forecasts, or the official Board.
- Early Slate tab clearly shows preview projections with amber labeling and per-side lineup source.

### Technical notes
- Files added: `src/lib/forecast/resolve-preview.ts`, `src/lib/forecasts/preview.functions.ts`, `src/routes/_authenticated/forecasts/early-slate.tsx`, `src/lib/forecast/__tests__/preview.test.ts`.
- Files edited: `src/lib/automation/orchestrator.ts` (preview pass + result shape), `src/lib/ingest.functions.ts` (write preview metadata), `src/components/forecasts-tab-bar.tsx` (new tab).
- No DB schema change required if preview metadata fits inside `sim_snapshot` JSON. If we prefer a typed column, add `preview_meta jsonb` via migration before the code change.
- Hashing: `preview_input_hash = sha256(model_version + probable_starters + projected_lineups_ordered + env_inputs)`. Distinct from the official `material_hash` so the two lifecycles never collide.
