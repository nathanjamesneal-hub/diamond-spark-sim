
# First-Pitch Forecast Cutoff — implementation plan

Diamond already has a partial cutoff inside the lifecycle writer
(`publishForecastIfEligible`). The legacy `projections` write path, the
preview-class branch, the lineup-refresh cron, and the admin UI all still
allow post-first-pitch writes. This plan closes those gaps with **one
shared server-side guard** and aligns every write path to it.

## 1. Single shared guard

Create `src/lib/forecast/window.ts`:

- `assertForecastWindowOpen(admin, gamePk)` — async. Loads the
  authoritative game row from `games` (status + first_pitch_at). Returns
  `{ open: true, game } | { open: false, gameStatus, reason }`.
- Reuses the existing `gameHasStartedOrPastStart()` logic from
  `lifecycle.ts` so live, in-progress, final, suspended-after-start, and
  delayed-after-first-pitch all close the window. Scheduled, Pre-Game,
  Warmup, Postponed (before start), "Delayed Start: Rain" stay open.
- Logs every closed result with the exact required shape:
  `console.log("[forecast.window]", { gamePk, gameStatus, action, decision: "forecast_window_closed" })`.
- Companion `filterOpenGames(admin, gamePks) → { openPks, blocked[] }` so
  batch write paths can skip live games in a single call.
- Re-export `gameHasStartedOrPastStart` from this file so
  `eligibility.ts`'s duplicate `gameHasStarted` collapses to one
  implementation.

This is the only function any write path should consult. No other write
path is allowed to re-implement "has the game started".

## 2. Enforce in every write path

For each path below: call the guard first, skip with a structured
`forecast_window_closed` result if closed, and emit the log line.

| Path | File | Change |
|---|---|---|
| Official forecast lifecycle | `src/lib/forecast/lifecycle.ts` | Replace inline check with `assertForecastWindowOpen`. Behavior unchanged: still locks any active `published` row when closed; still returns `post-first-pitch-skip`. |
| Legacy engine writer | `src/lib/ingest.functions.ts` `runDiamondEngineForGames` | Call `filterOpenGames` after loading `games`. Remove blocked games from `targetGameIds` / `eligibleGameIds` for BOTH `official` and `preview`. Do not call `projectForModelVersion`, `buildMonteCarloGameEnvironment`, `simulate()`, `buildHitterSnapshot`, `buildPitcherSnapshot`, or the `projections` insert for blocked games. Return new counters: `gamesSkippedWindowClosed`. |
| Daily pipeline | `runDailyPipeline` in `ingest.functions.ts` | Same filter applied to the per-game loop that decides which games go to the engine. |
| Force / preview admin | `forceRunDiamondEngine` | Same filter; preview is explicitly bound by the cutoff per spec. |
| Publish official admin | `publishOfficialForecast` | Same filter before delegating to lifecycle. |
| Lineup refresh worker | `src/lib/lineups/refresh.functions.ts` `runRefresh` | After the aggregator computes `changedGameIds`, filter through the guard. A lineup change for a game already in progress can update `lineups`/`game_lineup_status` rows (for audit) but MUST NOT trigger `runDiamondEngineForGames` for that game. Closed games are recorded in the cron run notes. |
| Per-game admin engine | `runEngineForGame` in `lineup-status.functions.ts` | Guard first; if closed, return `{ ok: false, decision: "forecast_window_closed", gameStatus }` and do not supersede. |
| Per-game lineup refresh | `refreshLineupsForGame` | Allow the lineup aggregator to run (audit), but do not allow it to chain into the engine for closed games. |
| Sim writer | `sim.functions.ts` `buildMonteCarloGameEnvironment` call sites | Already gated indirectly via the engine, but add a defensive guard inside the snapshot-write branch so a hand-rolled invocation cannot mutate `sim_snapshot` after first pitch. |
| Snapshot resolve | `src/lib/forecast/resolve.ts` | Guard before calling `publishForecastIfEligible` (cheap pre-check; lifecycle still enforces). |
| Any future write | Lint rule: a new ESLint rule `no-direct-projection-write` (custom or a README note + matcher in `tools/`) flags `.from("projections").insert/upsert/update` and `.from("forecast_runs").insert` outside `forecast/lifecycle.ts` and the guarded engine path. |

Every guard rejection returns a result the caller surfaces verbatim:

```ts
{ ok: false, decision: "forecast_window_closed", gamePk, gameStatus, reason }
```

## 3. Lock active official forecasts at first pitch

- Promote `lockForecastsForLiveGames(admin, date)` to run on a schedule
  (already exists, just unscheduled today). Add a `/api/public/hooks/lock-live-forecasts`
  server route guarded by the `apikey` anon-key header pattern; pg_cron
  calls it every minute during the live-game window (e.g. `*/1 12-23 * * *`
  Chicago, or just `*/1 * * * *` for safety since the function is cheap).
- The handler iterates today's Chicago slate, and for every game where
  `gameHasStartedOrPastStart` is true and an active `published` official
  run exists for any model version: atomically `update forecast_runs set
  status='locked', locked_at=now() where id=… and status='published'` (the
  `where status='published'` clause makes it idempotent and atomic). Every
  other column — `input_hash`, `simulation_seed`, `material_inputs`,
  `version_number`, `generated_at`, `model_version`, `projection_class`,
  `superseded_by` — is left untouched. `forecast_player_projections` rows
  are never modified.
- Migration adds a partial index to support the lookup:
  `CREATE INDEX IF NOT EXISTS forecast_runs_active_official_idx ON forecast_runs (game_pk, model_version) WHERE projection_class='official' AND status='published'`.

After lock, no further write is permitted (lifecycle already returns
`locked-skip`). All grading lives in `projection_results`.

## 4. No late forecasts

- The lifecycle already does the right thing for the official path
  (`ineligible-for-official` if inputs invalid, `post-first-pitch-skip` if
  closed). The legacy engine writer's new guard makes the same true
  there.
- Public read paths (`/forecasts`, `/diamond-scores`, `/odds`,
  `/top-props`, `/forecasts/lab/*`) already filter to
  `projection_class='official' AND status IN ('published','locked')`. Add
  a small read-side helper, `formatNoOfficialForecast()`, used in each
  empty-state card so the message is identical everywhere:

  > No official pregame forecast published.
  > Game began before a lineup-confirmed Diamond forecast was available.

- Preview rows are admin-only — public boards never fall back to them.

## 5. Admin UI behavior for live/final games

`src/routes/_authenticated/_admin/admin.tsx`:

- Load today's lineup status (already available via `getLineupStatus`) to
  derive a `windowClosedByGamePk` map.
- "Publish / Reissue Official Forecast" and "Generate Preview
  Simulations" buttons: each game card on the slate gets a small
  per-game state. When every eligible game on the slate is closed, the
  whole-slate button is disabled with tooltip "Forecast window closed —
  games are live". For per-game admin actions in
  `src/routes/_authenticated/lineup-status.tsx`:
  - `runEngineForGame` button → disabled + "Forecast window closed —
    game is live" once `gameHasStartedOrPastStart` is true.
  - Live games keep the existing "view locked forecast", "refresh live
    actuals", and "inspect diagnostics" affordances enabled.
- Even if a user crafts a request manually, the server guard rejects it
  and returns the structured decision, which the UI surfaces in the
  result row.

## 6. Read path rule

- `Today`, `Forecasts`, `Projection Lab` all read
  `forecast_player_projections` joined to a non-superseded
  `forecast_runs` row. The locked snapshot is what they render.
- Live-actuals polling (`useQuery` for `getActualsForDate`) keeps its
  45-second `refetchInterval`. It refreshes a separate query key from
  the projection query and must not invalidate
  `["projection-lab", *]`, `["diamond-scores"]`, `["sim-leaders"]`, or
  `["top-props"]` query keys. Audit the existing `onSettled` /
  `invalidateQueries` calls to confirm. Any accidental invalidate of a
  projection key for a live game is treated as a bug.
- Add a one-line read-side comment in each list loader: "this query is
  read-only against locked snapshots; never triggers simulate()".

## 7. Server logs

The guard emits the canonical line on every closed result. In addition,
each write-path caller logs its own structured wrapper:

```
[forecast.window.block] { gamePk, gameStatus, action: "runDiamondEngineForGames" | "publishForecast" | "refreshLineupsAndProject" | …, decision: "forecast_window_closed", actor }
```

so that blocks are attributable to a specific write entry, not only to
the guard.

## 8. Tests

New file `src/lib/forecast/__tests__/window.test.ts` (vitest) covering:

1. Live game with no prior forecast: lifecycle returns
   `post-first-pitch-skip`; legacy engine returns
   `forecast_window_closed`; zero rows written to `forecast_runs`,
   `forecast_player_projections`, or `projections`.
2. Published official run → game transitions to `In Progress` → cron
   handler flips it to `locked` with `locked_at` set; every other
   column unchanged (deep-equal snapshot before/after).
3. Ten consecutive live-actuals refresh calls (simulated by invoking
   `importResults` + read loaders) leave the locked
   `forecast_player_projections` row byte-identical (hash compare on
   all columns).
4. `runEngineForGame` admin action on a live game returns
   `forecast_window_closed`; no DB writes; emits the structured log.
5. Pregame "Delayed Start: Rain" → eligible; same game later flagged
   "Delayed" after first pitch → blocked.
6. React Query refetch test (vitest + @testing-library + a stub
   QueryClient): mounting the Projection Lab Means table during a live
   game with `refetchInterval` and `refetchOnWindowFocus` simulated never
   results in any call to the engine module (`simulate`,
   `buildMonteCarloGameEnvironment`, `runDiamondEngineForGames`,
   `publishForecastIfEligible`) — asserted via vi.mock spies.
7. Projection Lab snapshot test: with a locked official run + a stream
   of three actuals updates, the rendered table's "Diamond Score",
   "Hits μ", "Alpha Hit 1+" and "p50/p90" cells are unchanged; only
   the actuals column updates.

## 9. Migration

```
-- index for the per-minute lock job
CREATE INDEX IF NOT EXISTS forecast_runs_active_official_idx
  ON public.forecast_runs (game_pk, model_version)
  WHERE projection_class = 'official' AND status = 'published';

-- pg_cron: every minute, hit the lock endpoint with the anon key
SELECT cron.schedule(
  'lock-live-forecasts',
  '* * * * *',
  $$ SELECT net.http_post(
       url := 'https://diamond-spark-sim.lovable.app/api/public/hooks/lock-live-forecasts',
       headers := '{"Content-Type":"application/json","apikey":"<anon>"}'::jsonb,
       body := '{}'::jsonb
     ); $$
);
```

(The actual URL + anon key are substituted at migration write time.)

## Out of scope

- No change to Alpha math, Monte Carlo math, calibration math, Diamond
  Score formulas, or model versioning.
- No change to actuals ingestion, grading rules, or live polling UI.
- No new tables. Locking uses the existing `forecast_runs.status` and
  `locked_at` columns; legacy `projections.projection_status` retains
  its current `active`/`superseded` semantics.

## Technical notes for reviewer

- `gameHasStartedOrPastStart` and `gameHasStarted` are duplicate logic
  today (`lifecycle.ts` and `eligibility.ts`). The new `window.ts`
  becomes the only definition; the other two re-export from it.
- The legacy `projections` write in `ingest.functions.ts` line 649 is
  the single biggest leak; the guard must wrap both the per-row build
  loop AND the final `.insert(projections)`.
- `lineups/refresh.functions.ts` calls `runDiamondEngineForGames(date,
  changedGameIds, undefined, "official")`. The filter must happen
  before that call so blocked games never reach the engine, and the
  refresh job's `cron_runs.notes` should record which games were
  blocked.
- Lifecycle's existing supersede-then-insert pattern is preserved; the
  guard runs before any DB mutation.
