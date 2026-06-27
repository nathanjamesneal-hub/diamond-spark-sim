## Goal

Make the public Forecast Board scannable: 10–20 official forecasts visible without long scroll, with the heavy "why" detail hidden behind a click. Public board never shows preview forecasts.

## Where this lands in the app

- `/` Today page — "Top Forecasts" strip becomes a mini dense board (top 8 rows + "Open the Forecast Board →").
- `/forecasts` (today: redirects to `/diamond-scores`) — repointed to a new `/forecasts/board` route that is the new default Forecast Board.
- `/diamond-scores` — kept reachable but the public default view becomes the dense board. The current grid-of-cards moves behind a "Detail cards" view toggle (Board ↔ Cards) for power users / admins.
- Mobile: same board renders as compact stacked rows.

## New components

```text
src/components/diamond/forecast-board/
  forecast-board.tsx        ← controls + table/list shell, URL-synced
  forecast-row.tsx          ← one dense row (desktop grid / mobile stack)
  forecast-detail-drawer.tsx← right-side drawer, reads locked snapshot
  board-controls.tsx        ← sort / status filter / team / search / market toggle
  market-toggle.tsx         ← Hit 1+ | HR 1+ | TB | RBI | Pitcher
```

## Board row contract (default columns, in order)

```text
Player · Team   |  Opp / Time or Live  | #BO | Market  | Prob  | Mean | PA  | Diamond | Status | Actual
```

- Player + team abbrev (player links to `/players/$playerId`).
- Opp + first-pitch time, or live inning if in progress, or "FINAL".
- Batting order spot (— for pitchers).
- Primary market label driven by the Market toggle (default Hit 1+).
- Calibrated probability (single number, right-aligned, tabular-nums).
- Projected mean (H for Hit 1+, HR for HR 1+, TB, RBI, Outs for pitcher).
- Projected PA (or projected BF for pitchers).
- Diamond Score with quiet "#rank" suffix for top 10.
- Forecast status pill: Awaiting / Published / Locked / Live / Final (only Live and Final get color; everything else is muted).
- Actual stat line when live/final ("1-for-3", "0/4, 1K", "5.2 IP, 2 ER"). Empty otherwise.

Color rules (sparing):

- Live row: faint left rail in `--color-live`.
- Final + result beat projection: faint green left rail; missed: faint red. No badge per number.
- Rank 1: thin gold left rail. No tier badges in default view.

## Controls bar

- Sort: Diamond Score (default) · Hit Probability · Projected Hits · Projected PA · Game Time.
- Status filter chips (single-select): All · Live · Locked · Final. "All" still excludes preview/no-official.
- Team multi-select.
- Player search (client-side, by name).
- Market toggle: Hit 1+ (default) · HR 1+ · TB · RBI · Pitcher props. Switching toggles the Prob/Mean columns and the eligible rows (Pitcher mode shows only `DiamondPitcherCard`).
- All controls are URL-synced via existing Tanstack `validateSearch` (extend the schema in `diamond-scores.tsx` and re-use in the new route).

Default filter: `status ∈ {published, locked, live, final}` — preview/no-official always hidden on the public board.

## Click-to-expand detail drawer

- Right-side `Sheet` (shadcn) at `md+`; full-screen modal on mobile.
- Loads only persisted data from `getDiamondScores` payload + the card's `inputs_narrative`; does NOT call simulate. Re-uses existing `PrimaryMetricsRow`, `SimDetails`, `PredictionDrivers`, `WhyTheModelLikesThis`, score-components block.
- Sections, top to bottom:
  1. Player header + team/opp + first-pitch + forecast status + model version + locked-at timestamp.
  2. Primary metric: calibrated probability, projected mean, projected PA.
  3. Alpha raw vs calibrated probability (from snapshot fields, if present; otherwise show "—" with a tooltip — see Open question 2).
  4. Monte Carlo means and percentiles (P50/P90) from `sim_snapshot` (already on the projection row).
  5. Diamond Score breakdown (Contact/Power/Speed/PG/MG for hitters; pitcher_components for pitchers).
  6. Why Diamond likes it (`WhyTheModelLikesThis`).
  7. Game context (venue/weather if available, opp SP for hitters).
  8. Live / final actuals when present.
  9. Admin-only block (gated by existing admin check used in `/_admin`): raw inputs JSON dump + sim seed.
- "View full player page →" deep link.

## Today-page mini board

Replace the existing "Featured matchup" + "All games" grid header with:

- Featured matchup stays as-is (single hero).
- New "Top Forecasts" panel below the dashboard cards: 8 rows from the same `ForecastBoard` component, fixed `market=hit`, sorted by Diamond Score, no controls bar, footer link "Open the full board →" → `/forecasts/board`.

## Mobile layout

- Below `sm`, each row becomes a 2-line stack:

```text
Aaron Judge · NYY @ BOS · #2                   Locked
Hit 1+ 64%  |  1.24 H  |  Diamond 82           1-for-3
```

- Tap anywhere on the row opens the full-screen detail sheet.
- Controls bar collapses to: sort dropdown + status chips + search; market toggle and team filter behind a "Filters" sheet.

## Data: what the payload needs

`getDiamondScores` already returns most of this. To populate Mean / PA / Actual cleanly:

- Extend `DiamondHitterCard` and `DiamondPitcherCard` with `projected_mean`, `projected_pa` (or `projected_bf`), plus `forecast_status: "no_official"|"published"|"locked"|"live"|"final"` and optional `actual: { hits, ab, hr, tb, rbi, ip, er, k } | null`.
- Read mean/PA from the existing `sim_snapshot` JSON on the projections row (no live sim). Read status from `forecast_runs` (`status` + game state) and actuals from the existing `actuals` table already used in `model-results.functions.ts`.

This is a pure read-path change — no engine writes, no simulate calls, fully compatible with the first-pitch lock.

## Removed from default view (still in drawer)

Contact/Power/Speed mini-grid, all secondary market percentages, long narratives, raw distributions, multiple competing score badges, tier letter pills.

## Acceptance check

- Desktop 1280×800: ≥10 official rows visible above the fold on `/forecasts/board` with default filters.
- Top Hit 1+ row, projected mean, and Diamond Rank readable in <5s (single eye-line, right-aligned tabular numerics).
- Clicking a row opens the detail drawer with Alpha vs calibrated, MC means/percentiles, score breakdown, drivers — all from snapshot.
- Live/final rows show actuals in the Actual column; the locked Prob / Mean / PA do not change.
- `status='preview'` never appears on the board.
- Mobile: rows stack to 2 lines; tap opens full-screen detail.

## Technical notes

- New routes: `src/routes/_authenticated/forecasts.board.tsx` (the board); update `forecasts.index.tsx` to redirect to `/forecasts/board` instead of `/diamond-scores`.
- `diamond-scores.tsx`: add a `view=board|cards` URL param, default `board`; existing card grid renders only when `view=cards`. Keeps existing deep links working.
- Reuse `Sheet` (`src/components/ui/sheet.tsx`) for the drawer; no new dependency.
- Sorting/filtering stays client-side over the existing `getDiamondScores` payload (already deduped by active version).
- No DB migration. Snapshot fields used are already persisted; if `projected_mean` / `projected_pa` aren't yet extracted into the card type, do that read-only mapping inside `getDiamondScores` from `projections.sim_snapshot`.

## Open questions

1. On the Today page, should the mini "Top Forecasts" panel replace the current "All games" grid, or sit above it (and keep the games grid below)?
2. Alpha raw vs calibrated probability — is the raw Alpha prob already persisted on the snapshot, or should the drawer omit that row until snapshot includes it?
3. Pitcher market toggle label: "Pitcher props" or break into "Outs / K / QS / Win" sub-toggle inside Pitcher mode?
  Approve the dense Forecast Board plan with these required implementation changes.
  1. Keep projection class, forecast status, and game state separate.
  Public board visibility:  
  `projection_class = 'official'`  
  and forecast run status in `('published', 'locked')`  
  and latest non-superseded version only.
  Do not use `preview` as a status value.
  Board filter labels should be game-display states:
  - All
  - Upcoming
  - Live
  - Final
  Derive Upcoming / Live / Final from the joined game state plus forecast run status:
  - Upcoming = game pregame + forecast published
  - Live = game live + forecast locked
  - Final = game final + forecast locked
  2. Use a lightweight board payload plus lazy detail loading.
  The board loader must return only compact row fields needed for scanning.
  On row click, call a new read-only detail function such as:  
  `getForecastBoardDetail({ forecastRunId, playerId })`
  It may return stored snapshot detail, Alpha fields, Monte Carlo distributions, Diamond Score components, narrative, game context, and live actuals.
  Neither loader may call simulation, lifecycle publishing, lineup refresh, or write functions.
  3. Rank scope.
  Diamond Rank must be calculated within the current:
  - selected date
  - selected market
  - selected role
  - official active forecast set
  Do not show an all-category rank that makes Hit, HR, TB, and pitcher rows look directly comparable.
  4. Actual column must match the selected market.
  Examples:
  - Hit 1+: `1-for-3`
  - HR 1+: `0 HR`
  - Total Bases: `2 TB`
  - RBI: `1 RBI`
  - Pitcher Ks: `6 K`
  - Pitcher Outs: `17 Outs`
  - Pitcher Win: `Win` or `No decision`
  - QS: `QS` or `No QS`
  Keep the original locked probability, mean, PA/BF, and Diamond Score unchanged beside those live/final actuals.
  5. Today page placement.
  Keep the All Games grid.
  Place the new Top Forecasts mini-board directly below the dashboard/hero area and above the All Games grid:
  - top 8 official forecasts
  - Hit 1+ default
  - sorted by Diamond Score
  - no controls
  - footer link to `/forecasts/board`
  If no official forecasts are available:  
  `Awaiting confirmed lineups`  
  `No official Diamond forecasts published yet.`
  6. Alpha versus calibrated values.
  Never retroactively derive calibrated probability for an older locked forecast.
  - Show saved raw probability if present.
  - Show saved calibrated probability and calibration version if present.
  - If only raw exists: `Raw · uncalibrated`.
  - If neither was persisted: `Not stored in this snapshot`.
  For all new official forecasts, persist:
  - alpha_raw_probability
  - calibrated_probability
  - calibration_version
  7. Pitcher market behavior.
  Main market toggle:  
  Hit 1+ | HR 1+ | TB | RBI | Pitcher
  When Pitcher is selected, reveal a nested sub-toggle:  
  Ks | Outs | Walks | Win | QS
  Default pitcher sub-market: Ks.
  8. Data fidelity.
  Projected PA, projected BF, batting-order spot, opponent starter, weather, and narrative must come from the saved forecast snapshot first.
  Current lineup/game data may supply only live game state and actuals. Never reconstruct old locked projections from current roster or lineup data.
  9. Performance and integrity checks.
  - Board response must exclude preview rows at the server level.
  - Detail drawer opens without triggering simulation.
  - Opening board, sorting, filtering, searching, or opening drawers produces zero new forecast runs.
  - Desktop default board shows at least 10 official forecast rows above the fold.
  - Mobile rows remain two lines and open a full-screen detail sheet.