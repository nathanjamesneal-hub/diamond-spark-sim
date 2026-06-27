## Goal

Restore visibility into the engine without re-running it on read. Projection Lab reads only the persisted snapshots that `publishForecastIfEligible` already writes to `forecast_runs` and `forecast_player_projections`. No simulator calls on the read path. Results and Model stay as-is.

## Information architecture

Add three routes under the existing `/forecasts` hub. Tab bar gets a "Projection Lab" group with three sub-tabs.

```text
/forecasts (existing hub)
  Board · All · Rankings · Consensus · Top Props · Player Search
  Projection Lab ▾
    /forecasts/lab            -> Engine Status (default landing)
    /forecasts/lab/means      -> Simulation Means
    /forecasts/lab/alpha      -> Alpha vs Diamond
```

URL params on every Lab tab: `?date=YYYY-MM-DD` (default = latest Chicago slate with any official forecast row), `?gamePk=...`, `?team=...`, `?role=hitter|pitcher`, `?status=published|locked|live|final`, `?showPreview=0|1` (admin only).

## Data model in use (read-only)

Both tabs read from these tables. Nothing else.

- `forecast_runs(id, game_pk, game_id, slate_date, model_version, version_number, status, trigger_reason, input_hash, simulation_seed, material_inputs, generated_at, locked_at, superseded_by, notes)`
- `forecast_player_projections(forecast_run_id, player_id, mlb_id, role, diamond_score, confidence, hit/total_base/hr/rbi/sb/run_probability, pitcher_win/quality_start_probability, projected_outs, environment_agreement, distributions jsonb, inputs jsonb, created_at)`
- Joined for display only: `games`, `players`, `teams`, `lineups.batting_order`, `projection_results` (for "actual" columns once final). No writes from any Lab loader.

The Monte Carlo means / percentiles already live in `forecast_player_projections.distributions` (JSONB written by `buildHitterSnapshot` / `buildPitcherSnapshot`). The Lab reads `distributions.{hits,total_bases,hr,rbi,runs,sb}.{mean,p10,p50,p90}` and `distributions.{ks,outs,walks,win_prob,qs_prob}` for pitchers. If a field is missing on older snapshots, render `—` (do not synthesize).

## Tab 1 — Simulation Means (`/forecasts/lab/means`)

Sortable table, one row per `forecast_player_projections` row for the latest official `forecast_runs` per game on the selected date.

Hitter columns:

- player · team · opp · batting-order slot (from `lineups.batting_order` joined by player+game; show "—" if not available in the locked snapshot)
- status badge (`forecast_runs.status`: published / locked / live / final) — "final" is shown when the joined game is Final
- forecast timestamp (`locked_at ?? generated_at`)
- model version (`forecast_runs.model_version`)
- projected PA · projected hits mean · projected TB mean · projected HR mean · projected RBI mean · projected runs mean · projected SB mean
- p10 / p50 / p90 per stat (default shows hits; column picker reveals others) — sourced from `distributions`

Pitcher columns (only when role=pitcher):

- Ks mean · outs mean · walks mean · win prob · QS prob · p10/p50/p90

Footer row: total rows, distinct games, distinct model_versions present, count of rows missing `distributions` (data-integrity hint).

Advanced toggle (admin-only switch): adds `iterations` and `simulation_seed` columns and exposes raw `inputs` JSON in a side drawer.

Visibility:

- Default filter: `forecast_runs.status IN ('published','locked','live','final')` AND no `superseded_by`. The route never queries by `projection_class='preview'`.
- Admin `?showPreview=1`: includes preview runs and stamps each preview row with the existing amber "Preview — not an official Diamond forecast" banner row-styling.
- Empty state per game with no official run: "Awaiting confirmed lineups" (no synthesized values).

## Tab 2 — Alpha vs Diamond (`/forecasts/lab/alpha`)

Comparison table that separates the three layers so Diamond Score never visually replaces probability.

Columns, grouped under three header bands:

```text
| Player / Game / Status |  ALPHA ENGINE    |  MONTE CARLO     |  DIAMOND        |  ACTUAL |
                          raw hit prob       projected hits     Diamond Score
                          calibrated hit pr  projected PA       Diamond Rank
                                             dist p10/p50/p90   confidence
```

- "Alpha raw hit probability" = `hit_probability` from the snapshot (engine output before calibration). Source-of-truth: `forecast_player_projections.hit_probability`.
- "Calibrated hit probability" = lookup against `calibration_summary` row matching `(model_version, stat='hit', confidence_bucket)` and applying the persisted `predicted_mean → observed_mean` mapping. If no calibration row exists for that bucket, show "raw" with a small "uncalibrated" tag — never invent a calibration.
- "Projected hits mean" / "PA" = from `distributions.hits.mean` and `distributions.pa.mean` (or `pa` derived from snapshot inputs when stored).
- "Diamond Score" / "Rank" = `diamond_score`, ranked within the same date+role slice.
- "Actual hits" = `projection_results` joined when the game is final.

Explanatory header inside the page (always visible, two short lines):

> Alpha Engine = raw projection inputs and baseline probability.
> Monte Carlo = distribution and means simulated from those inputs.
> Diamond Score = ranking/confidence layer — not a substitute for probability.

Sort defaults: Diamond Rank ascending. Toggle to sort by calibrated hit probability descending. The page does not recompute Diamond Score from Alpha probability and does not modify probabilities for display.

## Tab 3 — Engine Status (`/forecasts/lab` default)

Top-of-Lab panel. All values resolved from persisted state, never hard-coded.

- **Active model version**: pulled by `SELECT version FROM model_versions WHERE active = true LIMIT 1`. If multiple actives exist, render all and flag as a warning.
- **Most-used model version in last 7 days of official runs**: `SELECT model_version, count(*) FROM forecast_runs WHERE status IN ('published','locked','live','final') AND slate_date >= today-7 GROUP BY 1 ORDER BY 2 DESC` — shown next to "Active" so drift is visible.
- **Calibration version**: latest `calibration_summary.computed_at` plus the distinct `model_version`s present.
- **Current simulation iteration count**: read from latest snapshot's `distributions.iterations` (or `inputs.iterations`) — never hardcoded. Constant `SNAPSHOT_ITERATIONS = 2000` is a writer detail; the panel reports what was actually persisted.
- **Forecast lifecycle status today**: counts of `forecast_runs` by `status` for today (Chicago).
- **Today has official lineup-confirmed forecasts?**: yes/no based on `forecast_runs.status='published'|'locked'` count > 0 for today.
- **Latest official publication timestamp**: `MAX(locked_at ?? generated_at)` filtered to non-preview rows.
- **Model changelog**: table from `model_versions` ordered by `release_date DESC` showing version, active, release_date, notes. (No external link — `notes` is the canonical changelog field today.)

## Version discipline (enforced in admin write paths, surfaced in Lab)

Lab is read-only, but it must make policy visible:

- Engine Status renders the active version from `model_versions.active=true`. Admin tooling that introduces formula/calibration changes must insert a new `model_versions` row (e.g. `alpha-0.4`) and flip `active`; it must never UPDATE existing `forecast_player_projections` rows.
- Add a Lab banner: "Historical forecasts are immutable — locked snapshots display original means/probabilities exactly as published."
- Shadow-mode rule: when a non-active version exists in `model_versions` and has `forecast_runs` rows for trusted historical dates, the Engine Status panel shows a "Shadow candidates" row listing `(version, runs, oldest, newest)` and a link to a future comparison view. The Lab itself does not promote a shadow version — that's an admin migration.
- The plan does NOT change any Alpha math or calibration. No "make Alpha more confident" change.

## Server functions (all under `requireAppMember`)

New file `src/lib/projection-lab.functions.ts`:

- `getProjectionLabMeans({ date, gamePk?, role?, team?, includePreview? })` — joins `forecast_runs` + `forecast_player_projections` + `games` + `players` + `teams` + `lineups.batting_order` + (when final) `projection_results`. Filters by official statuses unless caller is admin AND `includePreview=true`. Selects the latest non-superseded run per `game_pk`. Returns a plain DTO array.
- `getProjectionLabAlphaCompare({ date, includePreview? })` — same join shape but limited to hitter rows; left-joins `calibration_summary` on `(model_version, stat='hit')` bucket of the row's `hit_probability` for calibrated value.
- `getEngineStatus()` — returns active version(s), recent-version usage, calibration summary timestamps, today's lifecycle counts, latest official publication timestamp, shadow candidates, and `model_versions` changelog rows.

All three are GET, no writes, use the request-scoped Supabase client. No imports from `@/lib/sim.functions` or any writer module.

## Routes and components

New files:

- `src/routes/_authenticated/forecasts.lab.tsx` — layout route, renders `ProjectionLabTabBar` + `<Outlet />`.
- `src/routes/_authenticated/forecasts.lab.index.tsx` — Engine Status page.
- `src/routes/_authenticated/forecasts.lab.means.tsx` — Simulation Means.
- `src/routes/_authenticated/forecasts.lab.alpha.tsx` — Alpha vs Diamond.
- `src/components/projection-lab/lab-tab-bar.tsx` — three sub-tabs (Engine Status / Means / Alpha vs Diamond).
- `src/components/projection-lab/layer-legend.tsx` — the three-layer explainer reused across tabs.

Edit `src/components/forecasts-tab-bar.tsx`: append a final tab `{ to: "/forecasts/lab", label: "Projection Lab" }` and treat any pathname starting with `/forecasts/lab` as active.

Edit `src/routes/_authenticated/forecasts.tsx`: keep the redirect to `/diamond-scores` for the bare `/forecasts` URL (no behavior change).

Each new route defines `errorComponent` and `notFoundComponent`, uses Query + `ensureQueryData` / `useSuspenseQuery`, and puts the URL params through `validateSearch` + `loaderDeps` so date/filter changes invalidate cleanly.

## Visibility rules (recap, enforced in loaders)

- Public Lab views: only `forecast_runs.status IN ('published','locked','live','final')` AND `superseded_by IS NULL`.
- Admin toggle `showPreview=1`: also includes preview rows; each preview row gets the existing amber "Preview — not an official Diamond forecast" treatment (re-use the banner styling already used elsewhere). Permission check via the existing admin role helper used by the Admin panel.
- Historical dates: render the row exactly as persisted; never recompute, never call `simulate()`.
- Game with no official run: render a single "Awaiting confirmed lineups" placeholder row for that game; do not show empty stat cells with zeros.

## Non-goals (explicit)

- No changes to Alpha 0.3 math, calibration weights, or Diamond Score formula.
- No new write paths, no admin actions, no Edge Functions.
- No changes to `/results` or `/model`.
- No new database tables. `model_versions.notes` is the changelog source; if we later want a richer changelog we'll add a `model_version_changelog` table in a follow-up.

## Verification

- `rg "simulate\\(|buildMonteCarloGameEnvironment|publishForecastIfEligible|resolveAndPublishForecast" src/routes/_authenticated/forecasts.lab*` must return zero matches.
- `rg "from \"@/lib/sim" src/lib/projection-lab.functions.ts` must return zero matches.
- For a known locked date, the Means tab values for a sampled player match a direct SQL read of `forecast_player_projections.distributions` for that `forecast_run_id`.
- Engine Status `active model version` equals the SQL `model_versions WHERE active`.

Admin toggle off: preview rows are absent from the response payload (verified in network tab).

Approve Projection Lab as the next build. This should be completed before card-density or further model-math work.

The architecture is correct: Projection Lab must read persisted forecast snapshots only and must never call the simulator, lifecycle writer, or lineup refresh path.

Required adjustments before implementation:

1. Canonical naming  
Use the actual deployed class column consistently everywhere. Current lifecycle work refers to `projection_class`, so Lab filters must use:

`projection_class = 'official'`

Do not introduce mixed `forecast_class` / `projection_class` references.

2. Keep lifecycle status separate from game state  
Do not query or write forecast statuses named `live` or `final`.

- `forecast_runs.status`: `published | locked | superseded` as applicable
- game display state: scheduled / live / final from the joined `games` record

For display:

- scheduled + published = `Lineup-confirmed`
- live + locked = `Live`
- final + locked = `Final`

The original forecast remains locked throughout live and final states.

3. Snapshot fidelity for calibration  
Do not dynamically apply the latest `calibration_summary` mapping to historical Alpha probabilities.

For Alpha vs Diamond:

- raw probability = persisted snapshot value
- calibrated probability = persisted calibrated snapshot value and calibration version, if present
- if the historical snapshot did not persist calibration output, show:  
`Raw · uncalibrated`
- never invent or retroactively recalculate a calibrated historical number

This is necessary to preserve the exact forecast Diamond published before first pitch.

4. Use saved inputs first  
For batting order, confirmed starters, environment, and lineup context:

- source `material_inputs` from the forecast run first
- use current `lineups` data only as a fallback display enhancement
- if snapshot data is absent, render `—` or `Not stored in snapshot`
- never reconstruct a supposedly locked forecast from current roster data

5. Version-safe row selection  
When selecting the latest non-superseded forecast, partition by:

`game_pk + model_version`

Do not silently mix Alpha versions in one table.

Default to the active/public model version for the selected date. Add an optional `modelVersion` filter so historical Alpha versions and shadow candidates can be inspected intentionally.

6. Date behavior

- Explicit `?date=YYYY-MM-DD` must always win.
- Default date = latest Chicago-date slate with official persisted forecast rows.
- Never silently fall back to an older date.
- When the selected date has no official forecasts, show:  
`No official Diamond forecasts available for this slate`  
`Awaiting confirmed lineups or no pregame forecast was published.`

7. Preserve the strict read-only guarantee  
Add and pass these checks:

- `rg "simulate\\(|buildMonteCarloGameEnvironment|publishForecastIfEligible|resolveAndPublishForecast" src/routes/_authenticated/forecasts.lab*` returns zero matches.
- `rg "from \"@/lib/sim" src/lib/projection-lab.functions.ts` returns zero matches.
- Opening Means or Alpha vs Diamond ten times creates zero forecast runs and zero simulation calls.
- A sampled locked player row matches the exact stored JSONB distribution and saved probability fields from its `forecast_run_id`.
- Preview rows are absent from public payloads unless an authorized admin explicitly enables `showPreview=1`.

Keep the three Lab tabs exactly as planned:

- Engine Status
- Simulation Means
- Alpha vs Diamond

Do not change Alpha math, calibration weights, Diamond Score formula, Results, or Model in this build.