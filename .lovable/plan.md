
## Problem (verified against the live DB)

Chicago today = **2026-06-27**. Per-date snapshot:

```text
date         sched  final  terminal  hasActuals  official  locked
2026-06-27    15      0      no         no          0        0
2026-06-26    15     10      no         yes         0        0
2026-06-25     9      8      YES        yes         0        0
2026-06-24    16      0      no         yes         0        0
2026-06-23    15     14      no         yes         0        0
2026-06-22    12     12      YES        yes         0        0
```

Two stacked causes:

1. **Zero official locked forecasts exist anywhere.** `forecast_runs` is empty; `projections` only has `legacy_unverified` + `preview` rows. The lifecycle publisher (`publishForecastIfEligible`) is never being invoked by the daily pipeline, so the trusted track has no source data.
2. **`getDefaultModelResultsDate` is allowed to silently walk backwards.** Tier-1 (terminal + actuals + locked > 0) can never match while (1) is true, so it falls through to tier-2 (terminal + actuals) and lands on an older date (June 22 / 24 / 25 depending on which build was hit) with no banner explaining the jump.

## Scope

Frontend + the two server-fn modules that drive `/results` and `/model`. No engine math changes, no forecast-snapshot schema changes — only the date selector, the empty-state behavior, the diagnostic surface, and the `/model` range control. A separate follow-up will wire `publishForecastIfEligible` into the daily pipeline so trusted rows actually start landing; that is called out at the end.

## Changes

### 1. `src/lib/model-results.functions.ts`

- Rewrite `getDefaultModelResultsDate` to use trusted-only logic:
  - Tier 1: most recent Chicago date where `final == scheduled > 0` AND `snapshotCoverage.locked > 0` AND `hasActuals`.
  - Tier 2: most recent date where `final > 0` AND `locked > 0` (partial slates with trusted snapshots).
  - Tier 3: yesterday in Chicago, *flagged* as `reason: "no_trusted_forecasts_yet"`. Never silently pick a random older terminal-with-actuals date.
- Return `{ date, info, reason }` so the UI can show the "no trusted locked forecasts" empty state.
- `fetchDateInfo` already counts `official` + `locked` correctly — keep it, but also expose `final_count`, `pending_count`, `actuals_game_count` so the diagnostic table can reuse it.
- Add `getModelResultsDiagnostics({ days = 7 })`: returns an array of `ModelResultsDateInfo` for the last N Chicago dates (descending). One round-trip per date is fine at this size; reuses `fetchDateInfo`.
- Add `getTrustedDateRange()`: returns `{ first_trusted_date, last_graded_date, model_versions[], excluded_preview_count, excluded_legacy_count }` for the `/model` coverage header.
- All date enumeration uses `todayInAppTz()` and `lte('date', today)` with `order desc`. No `LIMIT 1` on the ranking query — we paginate the candidate list (top 30 days) and pick by predicate.

### 2. `src/routes/_authenticated/results.tsx`

- Loader passes the new `reason` through to the component.
- When `info.snapshotCoverage.locked === 0` OR `reason === "no_trusted_forecasts_yet"`, render the explicit empty state in place of the scorecard:
  - "No trusted locked forecasts available for {long date}."
  - "Diamond began trusted tracking after the write-once forecast lifecycle was introduced."
  - "Historical preview and legacy projections are excluded from official grading."
  - Mini counts row: `games X/Y final · official published Z · forecasts locked L · forecasts graded G`.
  - "Pick an earlier audited date" button that opens the date picker / jumps to the most-recent date with `locked > 0` if one exists.
- Partial-slate behavior unchanged in shape, but message becomes "Partial slate — X of Y games final." Grading list filters to `game_status IN (Final, Game Over, Completed Early)` only.
- URL `?date=YYYY-MM-DD` always wins: loader passes `deps.date` straight through, never overwritten. Add an assertion comment so future edits don't reintroduce the fallback.
- React Query keys already include the date — leave as-is, but confirm `staleTime` is short enough that switching dates refetches.

### 3. `src/routes/_authenticated/model.tsx`

- Add visible range control above the diagnostics grid:
  - `Since trusted tracking began` (default)
  - `Last 7 graded slates`
  - `Last 30 graded slates`
  - `Custom range` (two date inputs)
- Range state lives in URL search params: `?from=YYYY-MM-DD&to=YYYY-MM-DD` (omit both for "since tracking began"). Existing `?date=` continues to scope a single date; presence of `from` switches the page into range mode.
- Coverage header card (always rendered): trusted locked forecasts graded · first trusted date · most recent graded date · model versions included · excluded preview count · excluded legacy count. Sourced from `getTrustedDateRange()`.
- Small-sample guard: if total graded < 25 in the selected range, show an amber banner "Sample size too small for reliable diagnostics — N graded forecasts in range" instead of silently rendering legacy June 24 rows.
- Diagnostic counts table (new section "Date Coverage Diagnostics"): last 7 Chicago dates with `sched / final / official / locked / graded`. Drives directly from `getModelResultsDiagnostics`.

### 4. Data integrity (already aligned, re-asserted)

`getSimulationLeaders`, `getActualsForDate`, and `model-results.functions.ts` queries must all carry, together:

- `projection_class = 'official'`
- `projection_status = 'active'`
- `sim_snapshot IS NOT NULL`
- Join only to `projection_results` rows with finalized box score.
- Never include `legacy_unverified` or `preview`.

Add a short header comment in each file calling this rule out so future edits don't loosen it.

### 5. Tests

Add `src/lib/__tests__/model-results.default-date.test.ts` (vitest) with mocked supabase responses:

- Eligible dates June 24 (locked > 0) and June 26 (locked > 0): default = **June 26**.
- Eligible June 26 (locked = 0), eligible June 24 (locked > 0): default = **June 24**, `reason: "trusted_older_date"`.
- No locked anywhere: default = **yesterday Chicago**, `reason: "no_trusted_forecasts_yet"`.
- Explicit `?date=2026-06-26` overrides default even when `locked = 0`.
- Chicago midnight: a UTC timestamp at `2026-06-27T03:00:00Z` (still 2026-06-26 CT) resolves `todayInAppTz()` to `2026-06-26`.

### 6. Follow-up (called out, not built here)

Trusted rows don't exist yet because `publishForecastIfEligible` is not wired into `runDailyPipeline`. Without that, `/results` and `/model` will keep showing the new empty state correctly but never light up. A separate change should:

- Invoke `publishForecastIfEligible` per game inside `runDailyPipeline` once lineups confirm.
- Invoke `lockForecast(...)` on first pitch (cron tick or game-start hook).
- Backfill a single test slate to confirm the new defaulter promotes it.

I'll flag this at the top of the PR description and we can do it as the next ticket.

## Verification after the change

Re-run the diagnostic counts for **2026-06-22 through 2026-06-27** and post:

```text
date         sched  final  official  locked  graded   default-tier
```

Expected, given current data: every date `official=0, locked=0`, default lands on `2026-06-26` (yesterday CT) with `reason: "no_trusted_forecasts_yet"` and the explicit empty state is shown — no silent jump to June 24.

## Technical details

- New server fn signatures:
  - `getDefaultModelResultsDate(): { date, info, reason: "trusted_terminal" | "trusted_partial" | "no_trusted_forecasts_yet" }`
  - `getModelResultsDiagnostics({ days: number }): ModelResultsDateInfo[]`
  - `getTrustedDateRange(): { first_trusted_date, last_graded_date, model_versions, excluded_preview_count, excluded_legacy_count }`
- All three: `.middleware([requireAppMember])`, no admin client.
- `staleTime: 60_000` to match existing query options.
- Date math stays inside `todayInAppTz()` / `isoDateInAppTz()` from `src/lib/timezone.ts` — no `new Date(dateStr)` parsing anywhere new.
- Range control on `/model` uses `validateSearch` + `zodValidator` + `fallback`, matching the existing `?date=` pattern.
