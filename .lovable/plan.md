
## Goal

Make pregame Preview Simulations visible across every public forecast surface, while guaranteeing Official locked forecasts always win and Preview rows never contaminate Results / Model / Calibration.

## 1. Shared read-side selector (single source of truth)

New module: `src/lib/forecast/select-public.ts`

Export `selectPublicForecasts({ date, gameIds?, modelVersion? })` that returns one row per `(game_id, player_id, market, model_version)` using this priority:

1. `projection_class='official'` + `status='locked'`
2. `projection_class='official'` + `status='active'` (published)
3. `projection_class='preview'` + `status='active'` AND `game_status` is pregame (not Live/Final/Suspended-after-start)
4. else: drop the row

Returns each row tagged with `display_class: 'official' | 'preview'` and `lineup_completeness` (confirmed batters / 18) for preview rows, plus `preview_generated_at`.

Implementation: one SQL pass that joins `forecast_runs` → `forecast_player_projections` → `games`, ordered by class priority and `generated_at desc`, deduped in JS by composite key. Live/Final games drop any preview candidate. This is the only place priority rules live.

## 2. Wire every public surface to the selector

Replace direct `projection_class='official'` filters with `selectPublicForecasts(...)` in:

- `src/lib/projections.functions.ts` — `getDiamondScores`, `getSimulationLeaders`, `getTopProps`, `getForecastBoard`, `getProjectionsForGame` (public path), `getConsensusBoard`
- `src/lib/projection-lab.functions.ts` — public mode (keep an explicit `includePreview`/`adminMode` flag for the existing admin preview toggle so deep inspection still works)
- Today mini-board (`src/routes/_authenticated/index.tsx`) inherits via `getDiamondScores`

Untouched (must still filter to locked official only):
- `src/lib/model-results.functions.ts` (Results, Model, Calibration, Brier/log-loss, projected-vs-actual audits)
- Any "trusted performance history" / promotion paths
- `today.live.tsx` actuals grading

Add a unit assertion that `model-results.functions.ts` never imports `selectPublicForecasts`.

## 3. Public UI treatment

New component `src/components/diamond/preview-badge.tsx` (amber).

Row-level changes (Forecast Board, Top Props, Sim Leaders, Diamond Scores, Consensus, Today mini-board):

- Preview rows show: amber `Preview` badge, subtitle `Projected lineups`, `Projected lineups: X/18 confirmed`, preview generated timestamp. Never use the words `Locked`, `Official`, or `Lineup-confirmed`.
- Official rows show: `Lineup-confirmed forecast`, swapping to `Forecast locked at first pitch` once `status='locked'`.

Top Props & Sim Leaders:
- Add a scope filter `All Available | Official Only | Preview Only`, default `All Available`.
- Section headers split counts: `Official Forecasts (N)` and `Preview Forecasts (M)`.
- Preview rows never display `Safest` / `Official Top Prop` adornments.

Diamond Consensus:
- Include preview rows only when no official exists for that player/game/market.
- Label preview rows `Preview Alignment`.
- Sort: all official rows above all preview rows; within each, existing Consensus order.
- Persisted `forecast_consensus` (official, immutable) is unchanged. Preview Consensus is computed read-side and never written.

## 4. Lock / overwrite protection (verify, do not change math)

Audit-only confirmations in `src/lib/ingest.functions.ts` + `src/lib/forecast/lifecycle.ts`:

- Preview pass only runs when game is pregame (reuse `partitionOpenGames` cutoff guard) and material hash changed.
- Preview write path never touches rows where `projection_class='official'` (add explicit guard / test).
- Official publish never mutates preview rows.
- Add unit test: attempting to update an official row from the preview writer throws.
- Once `game_status` is live, the orchestrator preview pass skips that game (already enforced; add regression test).

## 5. Results / Model integrity (no changes, add guard tests)

Tests in `src/lib/forecast/__tests__/`:

- `select-public.test.ts` — priority, dedup, live-game preview drop, completeness reporting.
- `results-excludes-preview.test.ts` — `MR_*` audits only see `projection_class='official' AND status IN ('active','locked')`.
- `preview-immutability.test.ts` — preview writer cannot modify official; official publish does not modify preview.
- `consensus-preview-rank.test.ts` — official ranks above preview; persisted official Consensus unchanged after preview refresh.

## 6. Acceptance scenarios encoded as tests

1. Pregame-only game → appears in all 4 public boards with amber Preview.
2. Official publishes → public switches to official row, preview hidden.
3. Preview re-run cannot mutate any official/locked field.
4. Game flips to Live → no new preview row created.
5. Preview rows absent from Results / Model / Calibration queries.
6. No (game, player, market) shows both preview + official in any public board.

## Technical notes

- No schema changes. Reuses existing `projection_class`, `status`, `superseded_by`, `locked_at`, and `game_status` columns.
- Lineup completeness derived from `lineups` table where `lineup_status='confirmed'` per game.
- Selector returns at most one row per composite key — dedup happens in SQL via `DISTINCT ON (game_id, player_id, market, model_version) ... ORDER BY class_priority, generated_at DESC`.
- Admin Projection Lab keeps a `viewMode: 'public' | 'preview-inspect' | 'all'` param so admins can still inspect preview drafts side-by-side.

## Out of scope

- Diamond Score / Alpha / Monte Carlo / calibration math.
- Forecast lifecycle state machine.
- `forecast_consensus` persisted table schema.
- Orchestrator scheduling.
