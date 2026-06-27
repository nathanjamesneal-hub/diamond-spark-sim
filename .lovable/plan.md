# Fix live/snapshot-incomplete contamination of ranked Diamond surfaces

## What investigation showed

Dingler and Duran are NOT post-lock pinch hitters. They are confirmed starters
in the MLB lineup (BO 2 and BO 6). Their active rows are persisted as:

- `projection_class = preview`, `model_version = alpha-0.3`, `projection_status = active`
- `hit_probability` is set (0.859 / 0.838)
- `sim_snapshot IS NULL` → no persisted Monte Carlo distributions
- No `forecast_player_projections.distributions` row exists for the selected run either

`getDiamondScores` therefore emits a card with `hit_probability` set but
`sim_metrics.H.mean = null`. `consensusScore` tolerates `meanPct = null` and
ranks them off probability alone → they appear near the top of the Hits
category in Diamond Consensus with Sim Mean = "—".

So this is a **ranking-eligibility bug**, not a pinch-hitter bug, and not a
live-write bug. The fix is to gate every ranked public surface on a single
canonical "is this a valid pregame candidate for THIS market in THIS selected
run" check, and to require a finite persisted market mean alongside the
probability before a row may rank.

## Plan

### 1. Shared eligibility helper (new)

`src/lib/forecast/pregame-eligibility.ts`

```ts
isEligiblePregameForecastCandidate({
  role: "hitter" | "pitcher",
  market: MarketKey,                 // H | HR | TB | RBI | K | OUTS | BB | ...
  selectedForecast,                  // result of selectBestPublicForecast
  simMetrics,                        // getMarketSimulationMetrics(selectedForecast, role, market)
  probability,                       // proj.hit_probability / hr_probability / etc.
  lineup,                            // { batting_order, confirmed, locked_at } | null for pitchers
  projectionClass,                   // "official" | "preview"
}): { eligible: boolean; reason?: EligibilityReason }
```

A row passes ALL of the following or it is rejected:

1. `selectedForecast` is non-null (locked official → published official →
   pregame preview, per existing `selectBestPublicForecast`).
2. For hitters: `lineup.batting_order` is 1..9 AND either `confirmed` or
   `locked_at` is true. Pitchers must come from `starting_pitchers`.
3. The same selected snapshot contains a **finite, positive** `mean` for the
   requested market (`simMetrics.available && simMetrics.mean != null &&
   simMetrics.mean > 0`). Null / NaN / ≤0 is rejected, even if a probability
   exists.
4. The required probability for that market (when the market has one — Hit,
   HR, TB, RBI, Win, QS) is finite. Probability without a same-run mean does
   NOT make the row eligible.
5. The selected snapshot is from the same forecast run as the probability
   (already guaranteed because `selectBestPublicForecast` returns a single
   `{ projection, run, projectionClass }` tuple — assert it).

Rejection reasons are typed: `no_snapshot | no_lineup_slot |
missing_market_mean | non_positive_market_mean | missing_market_prob |
cross_run_mismatch | post_lock_addition`.

The helper is pure / read-only. It does NOT trigger sims, writes, or lineup
fetches.

### 2. Apply the helper everywhere a public list ranks rows

A single call site per surface — never component-level `mean != null` filters.

- `src/lib/projections.functions.ts` → `getDiamondScores`
  After building each hitter / pitcher card, run the helper per market the
  card exposes. Cards still build for diagnostics; add a per-market
  `eligibility: Record<MarketKey, { eligible; reason? }>` map on the card.
  Synthesize `is_post_lock_addition: true` ONLY when reason is
  `post_lock_addition`; do not synthesize cards for snapshot-incomplete
  starters (they stay as a non-eligible diagnostic card).
- `src/lib/sim.functions.ts` → `getSimulationLeaders` filters per market on
  the same helper before sorting.
- `src/routes/_authenticated/top-props.tsx` filters per market before
  ranking; surface a small footer count: "N hidden — pregame snapshot
  missing for this market" (separately from the existing in-game-add count).
- `src/routes/_authenticated/diamond-consensus.tsx` filters BEFORE
  percentile population is built (otherwise an ineligible row affects every
  other row's percentile).
- `src/components/diamond/forecast-board/forecast-board.tsx` keeps
  ineligible rows visible in the dense board but tags the Sim Mean cell
  "Unavailable" and excludes them from the default sort tiers.
- `src/routes/_authenticated/forecasts.index.tsx` (Today Top Forecasts) and
  Projection Lab public list use the same helper.

### 3. Consensus must require BOTH a mean and a prob for the active market

`src/lib/consensus.ts` — no formula change. Add a gate at the call site
(consensus page) that drops a row from a category whenever
`isEligiblePregameForecastCandidate` rejects it for that category's market.
This removes the current path where `meanPct = null` is silently treated as
0-weight and probability alone carries the score.

### 4. Live-write audit (read-only sweep)

Confirm that `src/lib/automation/live-actuals.ts`,
`src/routes/api/public/hooks/refresh-live-actuals.ts`,
`src/routes/api/public/hooks/lock-live-forecasts.ts`, and
`src/lib/lineups/refresh.functions.ts` never insert/activate
`projections` or `forecast_player_projections` rows after first pitch. If any
write path is found, restrict it behind `gameHasStartedOrPastStart` so live
workers can only update actuals.

No expected code changes here — this is verification, with a one-line note in
the orchestrator log if a guard is added.

### 5. Diagnostics endpoint (admin only)

Extend the existing telemetry function (`src/lib/automation/telemetry.functions.ts`)
with a small read-only helper `auditPregameEligibility(date)` returning:

- selected forecast run id / projection class / model version per (player, game, role)
- presence of `sim_snapshot.distributions`
- presence of matching `forecast_player_projections.distributions`
- saved batting-order slot
- per-market eligibility result + reason
- counts: removed-from-rank per surface, remaining visible-but-unrankable

Surfaced on `/admin` as a collapsible "Pregame Eligibility Audit" panel.

## Out of scope (will NOT do)

- Re-running Monte Carlo or backfilling preview `sim_snapshot` for missing
  rows. (The cause of the snapshot gap belongs to a separate ticket on the
  preview pipeline — this fix just stops contaminated rows from ranking.)
- Changing Alpha / Monte Carlo / consensus formula weights.
- Changing lifecycle, lock-live, or grading code.
- Adding new tables or migrations.

## Verification deliverables

After implementation I will return:

1. Exact source path that previously admitted Dingler / Duran (active preview
   projection row with `hit_probability` set + null `sim_snapshot` + no FPP
   distributions for the selected run) and their per-market eligibility
   result before/after (`eligible: false`, reason: `missing_market_mean`).
2. Count of rows removed from rankings per surface (Forecast Board ranked
   tiers, Top Props, Sim Leaders, Diamond Consensus, Today Top Forecasts,
   Projection Lab) — separately for `missing_market_mean` vs
   `post_lock_addition`.
3. Count of remaining ranked rows missing the required market mean — must be
   zero.
4. Three valid preview rows + three valid official rows with
   {player, batting order, selected run id, market, mean, probability,
   distribution source path}.
5. Confirmation that no simulation ran, no projections / forecast_runs /
   forecast_player_projections rows were modified, and no locked snapshot was
   altered.
