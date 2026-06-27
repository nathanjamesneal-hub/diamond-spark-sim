# Diamond — Forecast Classes, IA Refactor, Results & Card Rebuild

This is large enough that shipping it all in one pass would leave the app in a half-converted state for hours. Splitting into 4 sequential phases. Each phase is independently shippable and leaves the product honest at every checkpoint. Your own message says **"Do not redesign navigation yet. Make all forecast state honest and consistent first"** — Phase 1 honors that.

---

## Phase 1 — Forecast Class Honesty (do first, ship alone)

**Goal:** No public surface ever shows a probability sourced from a partial-lineup simulation again.

### Data model

Add a `forecast_class` to `forecast_runs`:

- `preview` — admin-only; created from probable pitchers or partial lineups
- `official` — both starters confirmed AND both 9-deep batting orders confirmed
- `locked` — official run frozen at first pitch (existing `status='locked'`)
- `legacy_unverified` — existing historical rows (no migration of meaning)

The existing `status` column stays (`awaiting`/`published`/`locked`/`superseded`). `forecast_class` is the new orthogonal axis that controls public visibility. The lifecycle writer decides class at publish time by checking lineup completeness; it never upgrades a `preview` row to `official` — re-runs create a new run.

### Lifecycle changes

`publishForecastIfEligible` gains an `intendedClass` argument:

- `engine_run` pipeline → `intendedClass: 'official'` only if both lineups are 9-deep confirmed AND both SPs confirmed; otherwise it returns `awaiting_official` and writes nothing.
- New admin action "Generate Preview Simulations" → `intendedClass: 'preview'`. Refuses to overwrite any existing `official`/`locked` row for the same `(game_pk, model_version)`. Writes go to the same tables but with `forecast_class='preview'`.

### Read-path enforcement (single chokepoint)

Every public read (`getSimulationLeaders`, `getDiamondScores`, `getConsensus*`, `getTopProps`, `getTodaySlate`, calibration loaders) filters `forecast_class IN ('official','locked')`. Preview rows are invisible everywhere except the Admin surface.

For games with no official forecast, the card payload returns a sentinel `{ forecast_state: 'awaiting_lineups' }` so the UI can render the empty state instead of nothing.

### Admin UI changes (minimum to unblock honesty)

- Rename "Force Run Diamond Engine" → **"Generate Preview Simulations"** with a yellow "Preview — not official forecast" banner on the resulting view.
- Add **"Publish/Reissue Official Forecast"** button, disabled with tooltip when lineup completeness check fails.
- Lineup Status dashboard adds five separate counters: Scheduled / Confirmed Lineups / Official Published / Previews / Locked.
- Remove the misleading "With Projections 15/15" metric.

### Tests (vitest)

1. `publishForecastIfEligible` with partial lineups + `intendedClass='official'` returns `awaiting_official` and writes nothing.
2. Preview publish refuses to supersede an existing `official` row.
3. `getSimulationLeaders` excludes preview rows.
4. `getCalibration*` excludes preview AND `legacy_unverified`.
5. An official row's `inputs_hash` and `distributions` are unchanged after a subsequent preview run for the same game.

**Ship gate:** All five tests green, dashboard counts match SQL, /odds and /diamond-consensus return zero rows for games without official forecasts.

---

## Phase 2 — Card Redesign (public surfaces)

After Phase 1, cards on `/today`, `/odds`, `/diamond-consensus`, `/top-props` are restructured around **one primary forecast** per card:

```text
┌──────────────────────────────────────────┐
│ Aaron Judge   NYY @ BOS   #2  •  7:10 PM │
├──────────────────────────────────────────┤
│ AT LEAST 1 HIT                           │
│       64%                                │
│ 1.24 projected hits · 4.4 PA             │
├──────────────────────────────────────────┤
│ Lineup-confirmed · Alpha 0.3 · 6:42 PM   │
│ ▸ Why Diamond likes it                   │
└──────────────────────────────────────────┘
```

Removed from default face: contact/power/speed blocks, every secondary market %, conflicting low-confidence pills, raw inputs. Diamond Score moves to a small rank chip in the header. Simulation details (mean/median/stddev) move behind an Admin-only expansion.

Forecast-state line drives all visual states: Awaiting / Lineup-confirmed / Locked / Live / Final.

**Ship gate:** Visual diff on `/today` and `/odds`; manual review of card on 3 sample players.

---

## Phase 3 — IA / Navigation Consolidation

Top nav collapses to **Today · Forecasts · Results · Model · Admin**.

Route map (old routes become redirects, no code deleted):


| New                                                              | Subsumes                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/today`                                                         | current `/today`, `/slate`, live game                                                      |
| `/forecasts` (tabs: Board / All / Rankings / Consensus / Search) | `/diamond-scores`, `/odds`, `/projections`, `/diamond-consensus`, `/top-props`, `/leaders` |
| `/results`                                                       | new (Phase 4)                                                                              |
| `/model`                                                         | `/calibration-lab`, `/model-results`                                                       |
| `/admin`                                                         | `/admin`, `/lineup-status`, pipeline logs                                                  |


Implemented as a thin layout route per area + page-level tabs. Old route files keep their loaders but their components render a `<Navigate to=…>` so deep links survive.

**Ship gate:** Every old URL still resolves, top nav has 5 items, no functionality removed.

---

## Phase 4 — Results Page ("Yesterday in Diamond")

`/results` defaults to the most recent date where every scheduled game is `Final`. If yesterday is partial → render `Partial slate — X of Y games final` and exclude unfinished games from all metrics.

Page sections (all sourced strictly from `forecast_runs WHERE status='locked' AND forecast_class IN ('official','locked')` joined to finalized actuals):

1. **Header strip** — date, finals/scheduled, locked-forecast coverage, model version(s), last actuals sync, date picker.
2. **Daily summary** — graded count, predicted avg vs observed rate, calibration delta, Brier, hits/misses, sample-size badge.
3. **Best Reads** — top correct locked forecasts with probability / projected line / actual line.
4. **Biggest Misses** — same shape; only factual reason labels backed by box-score data (`0-for-4`, `removed in 3rd`); never invented.
5. **Market Breakdown** — Hit 1+, TB 2+, HR 1+, RBI 1+, R 1+, SB 1+. Per-row Brier, observed rate, delta, sample warning.
6. **Model Note** — generated from the metric table only; one sentence; cites the number. No metric → no claim.

**Ship gate:** Acceptance test runs on a known historical date, all metrics match a hand-computed CSV from SQL.

---

## Technical notes

- **Migration:** one migration adds `forecast_class text not null default 'preview'` to `forecast_runs`, backfills existing rows by joining lineup completeness at publish time (rows for past dates with full lineup history → `official`; everything else → `legacy_unverified`), adds CHECK + partial unique index `(game_pk, model_version) WHERE forecast_class='official' AND status IN ('published','locked')`.
- **No new tables.** Preview vs official share `forecast_runs` / `forecast_player_projections`; the class column is the only gate.
- **Calibration protection:** `model_results` queries already gained the `legacy_unverified` filter — extend the same filter to exclude `'preview'`.
- **Lifecycle math unchanged.** No engine formula edits in any phase.
- **Subagents:** Phases 2 and 4 are visual-heavy; I'll spawn parallel subagents for the card component refactor (Phase 2) and the Results page layout (Phase 4) once Phase 1 lands.

---

## Order of execution

1. Phase 1 (this PR) — DB migration + lifecycle class gate + read filters + admin rename + 5 tests + dashboard counter fix.
2. Phase 2 — card redesign on public surfaces only.
3. Phase 3 — nav/route consolidation + redirects.
4. Phase 4 — `/results` build.

Approve and I'll start Phase 1.

Approve Phase 1 as the next standalone shipment. It solves the immediate product-integrity issue: public projections cannot exist from partial/projected lineups.

Before implementation, make these required corrections:

1. Keep forecast class and lifecycle status separate.
  - `forecast_class`: `preview | official | legacy_unverified`
  - `status`: `awaiting | published | locked | superseded`
  - `locked` is a status, not a forecast class.
  - An official forecast remains `forecast_class='official'` after first pitch; its status changes from `published` to `locked`.
2. Be conservative with historical backfill.  
Do not classify old projections as official merely because complete lineups can be reconstructed later. Only classify an old run as official if stored evidence proves both confirmed lineups, confirmed starters, and a pre-first-pitch generation timestamp. Otherwise mark it `legacy_unverified`.
3. The lifecycle must determine eligibility internally.  
`intendedClass='official'` is only a request, not authorization. The server must independently verify:
  - game has not started
  - both starters are officially confirmed
  - both batting orders are official, exactly 9 unique hitters, and slots 1–9 are present
  - official MLB/source data is used, not a projected lineup  
  If any check fails, return `awaiting_official` and write no official row.
4. Public read rules:
  - Today / Forecasts / Top Props / Consensus / rankings may read only `forecast_class='official'` with `status IN ('published','locked')`.
  - Results and calibration may read only `forecast_class='official'`, `status='locked'`, and final-game actuals.
  - Preview rows may appear only in Admin and must visibly say `Preview — not an official forecast`.
5. Preserve game visibility without fake probabilities.  
Public slate pages should still show scheduled games without official forecasts, but return:  
`{ forecast_state: 'awaiting_lineups' }`  
and render:  
`Awaiting confirmed lineups`  
`No official Diamond forecast published yet`  
Do not hide the game or replace the state with partial-lineup percentages.
6. Enforce active-version uniqueness transactionally.  
Keep the partial unique index by `(game_pk, model_version)` for active official `published` / `locked` rows, but ensure superseding the prior published run and inserting the next one happen in one transaction under the per-game advisory lock.
7. Add one additional test:  
A historical row with complete lineups discovered after the fact, but no verified pregame snapshot timestamp/input proof, must remain `legacy_unverified` and be excluded from public forecasts, Results, and calibration.

Ship Phase 1 alone after the tests pass and manually verify this exact case:

- Lineup Status: 2 confirmed games
- Official Published: no more than 2 eligible games
- Preview count shown separately
- Public Top Props / Consensus: zero forecast rows for the 13 non-confirmed games
- Public slate: those 13 games visibly say “Awaiting confirmed lineups”
- Admin Preview generation cannot change or replace an official forecast

Do not begin card redesign, navigation work, or Results until this is confirmed in production.