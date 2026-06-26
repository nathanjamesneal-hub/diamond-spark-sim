## Diagnosis (root cause)

Verified against the live database:


| Source                                                | Newest date                                         |
| ----------------------------------------------------- | --------------------------------------------------- |
| `games`                                               | 2026-06-26 (today CT)                               |
| `projections`                                         | 2026-06-26 (per-date rows exist back through 06-23) |
| `projection_results` (stored actuals from box scores) | 2026-06-25                                          |
| `cron_runs`                                           | 2026-06-26                                          |


What the page is actually doing:

1. `src/routes/_authenticated/calibration-lab.tsx` calls `getSimulationLeaders({})` and `getActualsForDate({})` with **no date**. Both server fns default to `chicagoToday()` → 2026-06-26.
2. Today's games are not Final yet, so the page shows ~0 qualified / mostly empty. There is no UI affordance to move back a day.
3. `getSimulationLeaders` does NOT read a stored snapshot — it re-runs `buildMonteCarloGameEnvironment(gamePk)` against the live MLB feed for every game on the selected date. For yesterday this both wastes work and violates "use the stored pregame projection snapshot."
4. There is no persisted mean-projection snapshot anywhere — `projections.inputs` only stores DNA/role; means come from the live sim run. So even with a date selector, history would be reconstructed, not the actual pregame snapshot.
5. The "June 24" appearance is the most-recent date with both stored projections AND fully-final actuals — the page latches there if Query has a cached result, or shows "today empty" otherwise.

Root cause: **no date control + no persisted pregame snapshot + actuals/leaders default to today**. The postgame pipeline also never freezes a per-day Model Results record.

## Fix plan (UI + storage + pipeline)

### 1. Persist a pregame mean snapshot (new column, no schema-breaking change)

Migration:

- `ALTER TABLE public.projections ADD COLUMN sim_snapshot jsonb;` (nullable, defaults null).
- Re-grant unchanged (column inherits table grants).
- Keep existing RLS; `sim_snapshot` is a passive payload `{ H:{mean,p50,p90,probAtLeast1,probAtLeast2}, TB:{…}, RBI, R, K, HR, outs, BB, ER, win_probability, quality_start_probability }`.

Writer:

- In `src/lib/ingest.functions.ts` (`runDailyPipeline`) and wherever projections are upserted after a Monte Carlo run, write the per-player distribution into `projections.sim_snapshot` for that `(player_id, game_id)` row.
- Engine math is untouched — we just persist the existing `BatterDist` / `PitcherDist` outputs.

### 2. Date-aware historical reader

`src/lib/sim.functions.ts`:

- Add `getSimulationLeadersForDate(date)` that:
  - If `date === todayInAppTz()` → existing behavior (live sim, today's slate).
  - Else → read `projections` joined to `games` for that date, hydrate `H/TB/RBI/R/K/HR/outs/…` from `projections.sim_snapshot`. Never call `buildMonteCarloGameEnvironment` for past dates.
  - If snapshot is missing for a past row, surface `null` (UI shows "snapshot unavailable" for that row) — never substitute today's sim.

`src/lib/actuals.functions.ts`:

- Add an option to read box-score actuals from `projection_results` first (we already store them), falling back to the MLB live API only when a row is missing. Same payload shape.

New helper `getModelResultsForDate(date)` (server fn) returns `{ date, leaders, actuals, status: 'final' | 'partial' | 'no_games' | 'no_snapshot' | 'pending_import', finalCount, pendingCount }`.

### 3. Default-date logic (Chicago)

New utility `getDefaultModelResultsDate()` (server fn, cheap SQL):

- Pick the **most recent `games.date` where every scheduled game has `game_status = 'Final'` AND a stored snapshot exists AND `projection_results` rows exist**.
- If nothing qualifies, fall back to the most recent date with any finalized games.
- Never silently return a date older than the latest finalized slate.

Page loader calls it; the date is always shown in the header.

### 4. Date controls (Model Results page only)

`src/routes/_authenticated/calibration-lab.tsx`:

- Convert `date` to a URL search param via `validateSearch` (Zod) — `?date=YYYY-MM-DD`.
- Loader resolves: `date = search.date ?? await getDefaultModelResultsDate()`.
- Header shows: `Reviewing results: {long date} · N finalized · M pending` and status messages:
  - `Results pending — X games still live or incomplete.` (partial)
  - `No games scheduled for this date.` (no_games)
  - `Final box scores have not been imported yet. Try refresh after the postgame pipeline runs.` (pending_import)
  - `Pregame snapshot unavailable for this date — historical review not possible.` (no_snapshot, for dates before the snapshot column was deployed)
- Controls row:
  - `← Previous day` (always enabled if any earlier date with games exists)
  - Shadcn date picker bound to `?date`
  - `Next day →` (disabled when no later finalized date exists)
  - `Latest Finalized` quick action → re-runs the default-date resolver
- Keep existing dark MLB styling (`mono`, `font-display`, `border-border/60`, etc.). No engine, scoring, probability, or security changes.

### 5. Daily finalization job

New endpoint `src/routes/api/public/hooks/finalize-slate.ts` (bearer `CRON_WEBHOOK_SECRET`, same pattern as `refresh-lineups.ts`):

- Accepts `{ date }`; if absent uses `todayInAppTz()` — but for the cron schedule we pass **yesterday's Chicago date** explicitly so the post-midnight run finalizes the correct slate.
- For the target date: (a) import final box scores into `projection_results`, (b) confirm `sim_snapshot` exists for every projection row, (c) recompute the Model Results aggregates, (d) write a `cron_runs` row tagged with that game date.

Schedule via `pg_cron` at 08:00 UTC (03:00 CT) every day calling the endpoint with `body := jsonb_build_object('date', (now() AT TIME ZONE 'America/Chicago' - interval '1 day')::date::text)`.

### 6. Safety / non-goals

- No changes to engine math, simulation iterations, probability math, calibration formulas, projection logic, RLS, `requireAppMember`, or auth.
- Existing per-day rows in `projections` / `projection_results` are preserved.
- Probability Calibration section is unchanged.

## Files touched

- `supabase/migrations/<new>.sql` — add `projections.sim_snapshot` column.
- `src/lib/ingest.functions.ts` — persist snapshot in `runDailyPipeline`.
- `src/lib/sim.functions.ts` — add historical reader; keep today path intact.
- `src/lib/actuals.functions.ts` — prefer stored `projection_results` for past dates.
- `src/lib/model-results.functions.ts` (new) — `getModelResultsForDate`, `getDefaultModelResultsDate`.
- `src/routes/_authenticated/calibration-lab.tsx` — date controls, status banner, URL search params.
- `src/routes/api/public/hooks/finalize-slate.ts` (new) + `pg_cron` schedule SQL.
- No changes to engines, security middleware, or design tokens.

## Outcome

Opening `/calibration-lab` after midnight CT lands on the most recent finalized slate (yesterday) and shows the real pregame-snapshot grades. Date controls let you walk backward through completed slates; forward is disabled until the next slate finalizes. Today's in-progress slate shows a clear "Results pending" banner instead of silently masquerading as historical data

## Required historical-integrity additions

### Snapshot immutability

`projections.sim_snapshot` must represent the final pregame model output, not a mutable cache.

- Persist the snapshot only after the final pregame pipeline run / lineup lock for that game.
- Include metadata inside the payload:
  - `captured_at`
  - `game_pk`
  - `player_id`
  - `lineup_hash` if available
  - `model_version`
  - `iterations`
  - `snapshot_status: "locked"`
- Once `snapshot_status` is locked, later projection refreshes must not overwrite that historical snapshot.
- A new live projection run may update normal current projection fields, but never rewrite the locked historical sim snapshot.

### Historical cutoff

Do not reconstruct historical mean projections for dates before snapshots existed.

For dates before `sim_snapshot` deployment:

- Probability Calibration may continue using legitimately stored probability/result data.
- Mean Projection Accuracy must show:  
`Pregame mean snapshot unavailable for this date. Historical Mean Accuracy begins with the first locked snapshot date.`
- Never rerun the live engine to fill historical Mean Accuracy rows.

### Completed-slate logic

Do not require every game to have status exactly `Final`.

Treat a date as terminal when every scheduled game is one of:

- Final
- Postponed
- Cancelled
- Suspended / rescheduled

Only grade player rows from completed Final games with:

- a locked pregame snapshot
- a matching stored actual result

Postponed, cancelled, and incomplete games should be excluded from qualified counts and visibly noted in the date status.

### Finalization reliability

The postgame finalization job must be idempotent and retry-safe.

- First scheduled run checks yesterday’s Chicago slate.
- If any game is still live/incomplete, write a `partial` status and do not freeze incomplete aggregates.
- Retry on a later schedule until all games are terminal.
- Once finalization succeeds, lock the daily Model Results record and avoid duplicate grading.
- Use the explicit target game date passed by cron; never infer historical game date from current UTC date.
- The cron endpoint must return only a minimal success/failure payload and remain protected by `CRON_WEBHOOK_SECRET`.

### Immediate UX fix

Ship the date selector and “Latest Finalized” behavior now.

Until valid mean snapshots exist:

- Default to the latest date with final actuals.
- Clearly label whether Mean Projection Accuracy is available for that date.
- Keep Probability Calibration visible when its stored data exists.
- Never show a reconstructed simulation as a historical pregame prediction.