
# Consensus v2 — Shadow-Only, Publication-Time Immutable Score

A new score computed exactly once when an official forecast publishes, persisted in its own table, and never recomputed on read. v1 stays in place, relabeled honestly, and runs side-by-side in shadow mode until v2 proves out.

Non-goals: no changes to Alpha math, Monte Carlo math, Diamond Score, calibration, locked forecast snapshots, or any existing write path.

---

## Phase 1 — Honest v1 (cosmetic)

- Rename UI surfaces of v1 from "Diamond Consensus" → **Model Alignment v1**:
  - `/forecasts/consensus` page title, header, nav label in `site-header.tsx` and `forecasts-tab-bar.tsx`.
  - Card/badge copy in board components.
- Add a persistent helper line under the title:
  > "Alignment v1 ranks agreement among overlapping Alpha and Monte Carlo outputs. It is not an independent-model probability or a persisted pregame score."
- Do NOT touch `src/lib/consensus.ts` math, weights, percentile windows, or any historical row.

## Phase 2 — Persistence: `forecast_consensus` table

New table written only by the lifecycle publisher. One row per (forecast_run_id, player_id, market, consensus_version).

```text
forecast_consensus
  id                 uuid pk
  forecast_run_id    uuid  fk → forecast_runs.id  (cascade)
  player_id          uuid  fk → players.id
  market             text  -- 'H1+', 'HR', 'TB', 'RBI', 'R', 'SB', 'K_pitcher', 'W', 'QS', ...
  consensus_version  text  -- 'v2.0'
  consensus_score    numeric(5,2)        -- 0..100, immutable
  score_confidence   numeric(5,2)        -- 0..100 cap from completeness/uncertainty
  computed_at        timestamptz default now()
  input_hash         text                -- equals forecast_runs.input_hash at publish
  components         jsonb               -- {baseline:{raw,norm,weight,contribution}, matchup:{...}, sim:{...}, form:{...}, quality:{...}}
  weights            jsonb               -- effective weights actually applied
  missing_components text[]              -- e.g. ['form']
  completeness       jsonb               -- {hitters_confirmed, sp_confirmed, n_peer_rows, ref_population, ref_window}
  uncertainty        jsonb               -- {tier:'A|B|C', stdev_band, n_basis}
  lineup_state       jsonb               -- snapshot of lineup_status, batting_order, opp SP at publish
  reference_meta     jsonb               -- {kind:'rolling_30d'|'same_slate', n, captured_at}
  notes              text
  unique (forecast_run_id, player_id, market, consensus_version)
```

Grants + RLS in the same migration: `GRANT SELECT` to `authenticated`; `GRANT ALL` to `service_role`; no `anon`. Policy: `SELECT` to authenticated when the parent `forecast_runs.projection_class='official'` AND `status IN ('published','locked')`.

Indexes: `(forecast_run_id)`, `(player_id, market, consensus_version)`, `(consensus_version, computed_at desc)`.

No update path. After insert, rows are immutable. Cascade delete only with the parent run (orphan cleanup).

## Phase 3 — Publication-time writer

New module `src/lib/consensus/v2.ts` exporting `computeConsensusV2(ctx, run, builtProjections)`.

Hook it in **one** place: `publishForecastIfEligible` in `src/lib/forecast/lifecycle.ts`, after the `forecast_player_projections` upsert succeeds (around line 432, decision = `published` or `superseded`). On `noop`/`awaiting`/`locked-skip`/preview class → do not write.

The writer:
1. Pulls components from the just-written snapshot (no MC re-run, no Alpha re-run).
2. Computes per-market v2 rows.
3. Inserts into `forecast_consensus` with `input_hash = run.input_hash`.
4. Failure is non-fatal for the forecast publish (logged, never throws past the lifecycle).

Backfill: a one-shot admin-only server fn `backfillConsensusV2(date)` that reads already-published official runs and writes v2 rows. Not on a public surface.

## Phase 4 — Component units (shadow scoring design)

Five units, computed from stored snapshot fields only:

- **A. Baseline** — player season rate × expected PA/BF from `forecast_player_projections.inputs` (already persisted).
- **B. Matchup** — opp SP grade, handedness split, park, environment from `inputs` (no recompute).
- **C. Simulation (one channel per market)** — binary markets (HR, SB, W, QS, H1+) use `*_probability`; count markets (TB, K, RBI, R, Hits-mean) use `distributions[stat].mean`. Never both for the same market.
- **D. Form residual** — capped residual of recent-form vs baseline from `inputs` if available, clamped to ±X. Computed but stored with weight 0 in v2.0 (shadow only).
- **E. Data-quality / uncertainty** — derived from `game_lineup_status`, `confidence`, distribution dispersion. Applied as a **cap** on `score_confidence` and as an uncertainty penalty; never as a bullish vote.

Component value pipeline:
1. Raw value from stored field.
2. Normalize against the chosen reference population (Phase 6).
3. Multiply by effective weight.
4. Sum contributions → `consensus_score`.

## Phase 5 — Initial v2.0 weights

```text
0.50  Calibrated market probability (primary event model — Sim channel for the market)
0.20  Baseline vs Matchup agreement (rank-correlation of A vs B normalized values)
0.15  Simulation certainty (1 − normalized stdev / IQR of the distribution)
0.15  Input completeness & uncertainty adjustment (from unit E)
```

If a component is unavailable: do NOT redistribute its weight to correlated Alpha/MC fields. Instead drop it from the sum, cap `score_confidence` (e.g. −15 per missing component), and add the unit name to `missing_components`. The row is flagged `incomplete` in the drawer.

## Phase 6 — Remove slate-dependent drift

At publication, store one of:
- `reference_meta.kind = 'rolling_30d'` — percentiles from a snapshot of the last 30 days of locked forecasts for the same market (preferred long-term).
- `reference_meta.kind = 'same_slate'` — same-slate population captured at compute time; `n` and the frozen population hash are persisted so the score is reproducible.

For v2.0 launch we use `same_slate` (no historical backfill burden) but persist `n` and the population hash so live-slate changes never alter the stored score.

Drawer/badge must surface `n` and an uncertainty tier (`A: n≥60`, `B: 20≤n<60`, `C: n<20`) so "Full Alignment" does not look identical at n=6 vs n=120.

## Phase 7 — Consensus Recipe drawer

Read-only drawer per v2 row (Forecast Board + dedicated v2 board):
- Original forecast `generated_at`, `locked_at`, `version_number`.
- `consensus_version`, `input_hash`, `computed_at`.
- Table: component | raw | normalized | weight | contribution | missing?
- Completeness + uncertainty fields.
- Final `consensus_score` and `score_confidence`.

Pulls only from `forecast_consensus` + parent `forecast_runs`. No sim, no recompute, no percentile recalc.

## Phase 8 — Shadow UI

- Existing `/forecasts/consensus` keeps v1 (relabeled "Model Alignment v1").
- New `/forecasts/consensus-v2` route (authenticated, internal flag: visible to admin role only at first via `has_role`). Renders v2 rows directly from `forecast_consensus`. Shows version, n, tier, drawer.
- Forecast Board row drawer gains a secondary tab "Consensus v2 (shadow)" when a v2 row exists.

## Phase 9 — Evaluation harness

`src/lib/consensus/v2-eval.functions.ts` (admin server fn) joins `forecast_consensus` to `projection_results` after games finalize and reports per market:
- Top-5 / top-10 ranking lift vs v1 alignment.
- Brier + log loss for binary markets.
- MAE for mean markets.
- Calibration deciles.
- Component correlation matrix (detect double-counting).
- Incremental value of Form residual after partialing out A/B/C.

Surface results on a new `/model/consensus-v2-eval` admin page. Promotion checklist documented in `.lovable/plan.md`; v2 stays shadow until it beats or matches v1 on a meaningful trusted sample.

## Phase 10 — Tests

Vitest under `src/lib/consensus/__tests__/`:
- `immutability.test.ts` — write v2 row, mutate live slate / poll actuals / lock the run → re-read identical bytes.
- `peer-removal.test.ts` — remove a peer row from the live slate after publish → stored v2 unchanged.
- `preview-blocked.test.ts` — publish with `projection_class='preview'` → no `forecast_consensus` row.
- `no-double-count.test.ts` — for each market, exactly one Sim channel contributes (mean XOR prob).
- `no-render-compute.test.ts` — render the v2 board and recipe drawer in jsdom, assert `computeConsensusV2` is never called and no MC import is reachable.
- `reproducibility.test.ts` — given stored `components` + `weights`, recompute score → equals stored `consensus_score` to 2 dp.

---

## Technical notes

- Files added: `supabase/migrations/<ts>_forecast_consensus.sql`, `src/lib/consensus/v2.ts`, `src/lib/consensus/v2-eval.functions.ts`, `src/routes/_authenticated/forecasts.consensus-v2.tsx`, `src/components/diamond/consensus-v2/*`, `src/lib/consensus/__tests__/*`.
- Files edited: `src/lib/forecast/lifecycle.ts` (one hook after upsert), `src/routes/_authenticated/forecasts.consensus.tsx` (relabel + helper text only), `src/components/site-header.tsx`, `src/components/forecasts-tab-bar.tsx`, `src/components/diamond/forecast-board/detail-drawer.tsx` (shadow tab).
- Files NOT touched: `src/lib/consensus.ts`, `src/lib/sim.functions.ts`, `src/lib/engines/**`, `src/lib/forecast/material-hash.ts`, `src/lib/forecast/window.ts`, calibration modules, projection writers, locked snapshots.
- DB-only writes happen inside `publishForecastIfEligible`; no edge function, no cron, no read path triggers a write.
- All v2 reads filter `consensus_version='v2.0'` so future v2.1+ can land additively.
