## Phase 1.5 — Smoke Test + Terminology Lock

### A. Canonical column name audit (pre-test)
Pick one canonical name and eliminate mixed references. Recommendation: **`projection_class`** (matches the current migration + DB column; cheaper than a rename migration).

Audit + normalize in this order:
1. `psql` confirm actual column on `forecast_player_projections` and `projections`.
2. Grep repo for both `forecast_class` and `projection_class` across:
   - migrations
   - `src/lib/forecast/lifecycle.ts`, `eligibility.ts`, `resolve.ts`, `material-hash.ts`
   - public readers: `projections.functions.ts`, `sim.functions.ts`, `actuals.functions.ts`, `model-results.functions.ts`, `lineup-status.functions.ts`, `consensus.ts`, `results-helpers.ts`
   - admin queries + `_admin/admin.tsx`
   - RLS policies on `forecast_player_projections` / `forecast_runs`
   - tests under `src/lib/engines/**`
3. Rewrite all stragglers to `projection_class`. Add a one-line comment in `lifecycle.ts` declaring it canonical.
4. Add a unit assertion in `engine.test.ts` (or new `forecast/lifecycle.test.ts`) that the published row has `projection_class === 'official'`.

### B. Four-case production smoke test
Run against current Chicago-date slate, record results in `.lovable/smoke-2026-06-27.md`.

**Case 1 — Game without confirmed full lineups**
- Pick a scheduled game where `game_lineup_status` < confirmed_9 for either side.
- Verify Today / Top Props / Consensus / Scores / Sim Leaders show no probability rows for those players.
- Verify game card shows: "Awaiting confirmed lineups" + "No official Diamond forecast published yet."

**Case 2 — Generate Preview Simulations**
- From Admin → Generate Preview Simulations on an ineligible game.
- Confirm preview rows appear only in Admin with amber "Preview — not an official Diamond forecast" banner.
- Re-check every public surface (Today, Top Props, Consensus, Forecasts, Results, Calibration) — diff must be zero.

**Case 3 — Publish one eligible official forecast**
- Find a game with 2 confirmed SPs + both 9-deep confirmed orders.
- Admin → Publish Official Forecast.
- Confirm `forecast_runs.status='published'`, `projection_class='official'` on rows.
- Record in smoke doc: `run_id`, `published_at`, `model_version`, one player's `hit_prob` and `H.mean`.

**Case 4 — Lock / live behavior**
- After first pitch, verify `forecast_runs.status='locked'`.
- Refresh app; re-run preview generation.
- Re-query the same player row; assert every official field (hit_prob, H.mean, HR.mean, model_version, published_at, locked_at, material_hash) is byte-identical to Case 3.
- Verify live actuals update on the public card while forecast numbers do not.

Gate: all four cases must pass before Phase 2 ships.

---

## Phase 2 — Public UI Consolidation

### 1. Collapse top navigation to 5 items
Replace `src/components/site-header.tsx` nav array with exactly:
`Today` · `Forecasts` · `Results` · `Model` · `Admin (role-gated)`.

### 2. Route redirects (preserve all loaders + URLs)
Add thin redirect route files. Each renders nothing and calls `throw redirect(...)` in `beforeLoad`:

| Old route | New destination |
|---|---|
| `/odds` | `/forecasts?tab=rankings` |
| `/diamond-scores` | `/forecasts?tab=board` |
| `/top-props` | `/forecasts?tab=rankings` |
| `/diamond-consensus` | `/forecasts?tab=consensus` |
| `/projections` (`/slate`) | `/forecasts?tab=all` |
| `/leaders` (`/leaderboards`) | `/forecasts?tab=rankings` |
| `/sim-leaders` | `/forecasts?tab=rankings` |
| `/calibration-lab` | `/model` |
| `/model-results` | `/model` |
| `/lineup-status` | `/admin` (pipeline tab) |

Underlying loader files (`projections.functions.ts`, `sim.functions.ts`, etc.) stay; only route shells move.

### 3. Build `/forecasts` with page-level tabs
New file `src/routes/_authenticated/forecasts.tsx` with query-param tabs:
- **Board** (default): concise list of official lineup-confirmed forecasts only, one card per player, hit-market primary.
- **All Forecasts**: existing slate/projections table, filtered to `projection_class='official'`.
- **Rankings**: existing Sim Leaders, official-only.
- **Consensus**: existing Diamond Consensus board, official-only.
- **Player Search**: lightweight search → `/players/$playerId`.

No "Safest Hit" label anywhere.

### 4. New public ForecastCard component
`src/components/diamond/forecast-card.tsx` replaces the overloaded Diamond Score card on Today + Forecasts Board.

Default face:
```
Aaron Judge                          NYY @ BOS · #2 · 6:42 PM CT
─────────────────────────────────────────────────────────────
PRIMARY FORECAST
At Least 1 Hit            64%
1.24 projected hits · 4.4 projected PA
─────────────────────────────────────────────────────────────
Lineup-confirmed forecast · alpha-0.3 · 6:42 PM
                                Diamond Rank #3   [Why ▾]
```

State variants (driven by `forecast_runs.status` + game state):
- No official → "Awaiting confirmed lineups" / "No official Diamond forecast published yet." (no numbers).
- Published → "Lineup-confirmed forecast".
- Locked → "Forecast locked at first pitch".
- Live → preserve original locked numbers; append `Live · 1-for-2 through 5`.
- Final → preserve forecast; append `Final · 2-for-4`.

Removed from default face: contact/power/speed ratings, secondary market probabilities, raw sim internals, confidence pills, "low confidence" tags, debug input grids. Admin keeps an expanded variant `ForecastCard variant="admin"` showing raw inputs + sim detail.

### 5. Today + Results integrity
- `/` (Today): swap player cards for `<ForecastCard>`. Games without official forecasts stay visible with the empty-state copy above. Remove any probability/rank/Top-Prop affordances when no official forecast exists.
- `/results`: when no eligible locked-official forecasts exist for the date, render: "No trusted locked forecasts available for this slate" + one-line explanation. Never fall back to preview / legacy / published-only / moving historical projections (enforce in `results.tsx` query filters: `projection_class='official' AND status='locked' AND finalized=true`).

### 6. Acceptance checklist (must all pass)
- Top nav has exactly 5 items.
- Every old URL in the redirect table 302s/route-redirects to its mapped target.
- A new user reads one ForecastCard in <5s and identifies the primary market + probability.
- No public surface renders a preview row (grep readers for `projection_class !== 'official'` access paths).
- Games without official forecasts show empty state, not fake numbers.
- `/results` + `/model` queries filter on locked official snapshots + final actuals only.
- Diamond Score appears only as secondary rank chip on the card.

### Out of scope (explicit)
- No model-formula changes.
- No Results page redesign beyond empty-state copy + filter tightening.
- No Model page redesign (Phase 3).
- No new probability markets or calibration math.

### Technical notes
- Tabs in `/forecasts` use `useSearch()` + `navigate({ search })` so deep links and redirects preserve tab state.
- Redirect routes use TanStack `beforeLoad: () => { throw redirect({ to: '/forecasts', search: { tab: 'rankings' } }) }`.
- `ForecastCard` is presentational; data shape comes from existing `getDiamondScores` / forecast resolver output — no new server fn needed for Phase 2.
- Admin pipeline/lineups/previews/lifecycle become tabs inside `/admin` rather than separate top-nav entries; existing routes can stay as `/admin/lineups` etc. under the admin layout.
