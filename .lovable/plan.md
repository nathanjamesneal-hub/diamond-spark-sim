## Goal

Ship two tightly-scoped production changes for today's unstarted slate without touching locked/started forecasts or unrelated pages.

---

## Part 1 — Replace inflated Alpha forecasts (`alpha-0.3.1-sample-shrink`)

Shrinkage math already landed last turn in `src/lib/sim/shrinkage.ts` and is wired into `src/lib/sim.functions.ts`. What's missing is the versioned rollout + persistence + supersession.

### 1a. Register the new model version

- DB migration: `INSERT INTO model_versions (key, label, active, created_at) VALUES ('alpha-0.3.1-sample-shrink', 'Alpha 0.3.1 (Sample Shrinkage)', true, now())` and flip `alpha-0.3` to `active=false`. Keep all historical `alpha-0.3` rows untouched.
- `src/lib/engines/registry.ts`: register `alpha-0.3.1-sample-shrink` reusing the Alpha 0.3 engine entry point. The engine code stays identical — only the version label and the (already-shipped) shrunk inputs differ.
- Mark `R` (Runs) as `unavailable` in the new version's metadata so the Forecast Board can render "N/A" for the runs column under the new version. Do NOT silently zero or cap; explicit unavailability.

### 1b. Persist shrinkage metadata on every new snapshot

Extend the snapshot payload built in `src/lib/sim-snapshot.ts` (and the writer in `src/lib/ingest.functions.ts`) with a `shrinkage` block per player:

```jsonc
shrinkage: {
  sampleOpportunity, fullTrustOpportunity, maxPriorOpportunity,
  priorOpportunity, shrinkageWeight,
  perOutcome: { K:{rawCount,rawRate,leagueRate,shrunkRate,shrunkCount}, BB:…, HR:…, … }
}
```

Source = the `diagnostics` object already returned by `shrinkHitterCounts` / `shrinkPitcherCounts`. No new math.

### 1c. Generate replacement runs for unstarted games only

Add `replaceInflatedAlphaForUnstartedGames(date)` in `src/lib/ingest.functions.ts` that:

1. Lists today's games and filters out any game where `gameHasStartedOrPastStart()` is true (reuses existing first-pitch guard — never mutates locked/started forecasts).
2. For each remaining game, runs the engine under `intendedVersion = 'alpha-0.3.1-sample-shrink'` to produce a new immutable `forecast_runs` row + `projections` rows.
3. Only after the new run inserts successfully, marks the prior active `alpha-0.3` run as `superseded=true` for that game (same supersede path Petri already uses). Failed insert → leave old run intact.
4. Returns `{ replaced, superseded, skippedStarted }` counts.

### 1d. Public selection

`src/lib/forecast/select-public.ts` (and the Forecast Board read path in `src/lib/projections.functions.ts::getDiamondScores`) already filters by `activeVersion`. Once 1a flips `active`, the board automatically reads the new run for unstarted games and still shows the old locked `alpha-0.3` snapshot for started/locked games. No UI changes needed beyond rendering "N/A" for Runs under the new version.

### 1e. Trigger

Add a one-shot call to `replaceInflatedAlphaForUnstartedGames(todayInAppTz())` at the end of the next `orchestrate-slate` cycle, gated by `activeVersion === 'alpha-0.3.1-sample-shrink'` so it self-heals and then becomes idempotent (input-hash guard prevents duplicate runs).

---

## Part 2 — Petri automation + live tracker

Auto-generation, first-pitch lock, and per-game idempotency by `(game_id, model_version, projection_class, input_hash)` are already implemented in `src/lib/petri/run.functions.ts::runPetriAutoForDate` and wired into the orchestrator. Two real gaps remain:

### 2a. Admin access fix

Discovery: site header link points to `/admin` but the route is `/admin/admin`, and there's no top-level Petri nav entry. Last turn added the link but the user still can't load `/petri` — that suggests the `_admin` route gate or RLS path. Verify and, if needed, fix:

- Confirm `src/routes/_authenticated/_admin/petri.tsx` resolves to `/petri` (since the layout is pathless). If the file actually creates `/admin/petri`, add a top-level redirect or rename so the nav link works.
- Verify RLS on `petri_forecast_runs` / `petri_player_market_snapshots` allows `authenticated` admins via `has_role`. Patch policies if not.

Report the exact root cause + the patch.

### 2b. Petri Live Tracker (Admin-only)

Extend the existing `/petri` admin page (no new route) with a Live Tracker section per locked game:

- **Server fn** `getPetriLiveTracker(date)` in `src/lib/petri/run.functions.ts`:
  - Loads locked official Petri runs for `date` from `petri_player_market_snapshots`.
  - Joins live actuals via existing `getActualsForDate(date)` helper (same one Alpha uses).
  - Returns hitter rows: `{player, mean_H, hit1plus, mean_TB, tb2plus, mean_HR, hr1plus, actual_PA/H/TB/HR/K, status, grade}` and pitcher rows: `{player, mean_K, range_K, mean_outs, range_outs, actual_K/outs/BB/H/ER/pitches, status, grade}`.
  - Grade fills only when game `final`.
- **UI**: new `<PetriLiveTracker/>` collapsible card inside the existing Petri Lab page, with the mandatory label `Petri v0.2 Shadow — Raw / Not Yet Calibrated`. Late additions with no locked snapshot render a single row `No Petri pregame forecast`. Polls every 45s like the existing Alpha live tracker.

### 2c. Hard immutability assertion

Add a unit test in `src/lib/petri/__tests__/lock.test.ts` confirming the lock path rejects any update to a `locked` Petri snapshot. Same for Alpha already covered by existing tests.

---

## Files touched

**Schema migration**
- `model_versions` insert + activation flip (no table changes).

**Code**
- `src/lib/engines/registry.ts` — register new version, mark `R` unavailable.
- `src/lib/sim-snapshot.ts` — persist shrinkage diagnostics block.
- `src/lib/ingest.functions.ts` — `replaceInflatedAlphaForUnstartedGames` + supersede.
- `src/lib/automation/orchestrator.ts` — call replacement once new version is active.
- `src/lib/petri/run.functions.ts` — `getPetriLiveTracker`.
- `src/routes/_authenticated/_admin/petri.tsx` — Live Tracker section + label.
- Possibly `src/routes/_authenticated/_admin/route.tsx` or RLS migration if 2a uncovers a policy gap.
- `src/lib/petri/__tests__/lock.test.ts` — new.

**Out of scope (explicitly NOT touched)**
- Locked / started Alpha runs.
- `alpha-0.3` historical rows.
- Diamond Score / Consensus / Top Props / public Results — Petri stays isolated.
- Runs (`R`) math fix — flagged as separate known defect; marked unavailable only.

---

## Return report (what I'll send back after running)

1. Alpha: `{ replaced, superseded, skippedStarted }` counts for today.
2. Before/after H/HR/TB/RBI means + raw PA + prior used for two previously-inflated hitters.
3. Petri access root cause + the exact code/policy fix applied.
4. Petri today: `{ eligible, preview, official, locked, skipped, abstained }`.
5. One locked Petri hitter + one locked Petri pitcher with source paths, input hash, forecast, live actuals.
6. Confirmation that locked Alpha and Petri snapshots are immutable under live updates (RLS + unit test reference).
