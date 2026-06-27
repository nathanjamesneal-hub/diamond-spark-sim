
## Goal

1. Publish the project so the publication-gap reconciliation pass I added earlier reaches production.
2. Immediately drive the slate once against production so HOU @ DET (824257) and NYY @ BOS (824745) get their official forecasts before first pitch, then return the verification table.
3. Build the standing, browser-independent server orchestrator that runs the same path every 2 minutes and removes the need to ever click the manual button for a normal slate.

No model math, calibration, Diamond Score, Consensus, snapshot values, UI logic, or forecast lifecycle rules change.

## Phase 0 — Publish + immediate slate trigger

- Run the website-info preflight, then call `preview_ui--publish`.
- Once production is live, POST `https://diamond-spark-sim.lovable.app/api/public/hooks/refresh-lineups` with the existing `CRON_WEBHOOK_SECRET` (pulled from Vault via `secrets--fetch_secrets`). This is the same path the 15-minute cron uses; with the new gap-reconciliation step, the eligible-but-unpublished games are added to the engine batch on this single call.
- Pull verification SQL for 824257 and 824745:

```text
gamePk | matchup | official_run_id | projection_class | status | generated_at | version_number | preview_count | public_visible
```

- Confirm: published_at timestamp is before `first_pitch_at`; preview rows still `projection_class='preview'` and excluded from the public read filter; public Forecast Board / Consensus / Projection Lab now return the official rows; no projection field on preview rows was mutated.

## Phase 1 — `orchestrateDiamondSlate` orchestrator

New file `src/lib/automation/orchestrator.ts` exposing one pure function `orchestrateDiamondSlate(date)` that wraps the existing pieces in a fixed order, per game:

1. Refresh game state for that game only — reuse the lineup aggregator + MLB schedule probable-pitcher / status fetch already inside `runRefresh`, refactored into `refreshGameState(gameId)` so it can be called per game without duplicating logic.
2. `assertForecastWindowOpen(gamePk)` — thin wrapper over the existing `gameHasStartedOrPastStart` guard in `src/lib/forecast/window.ts`. Throws a typed `ForecastWindowClosedError` that every write path catches and converts to a lifecycle log row.
3. If pregame, run the eligibility check (existing `evaluateOfficialEligibility`) and either log `awaiting_lineups` or call `publishForecastIfEligible({ gamePk, modelVersion: activeModelVersion, forecastClass: 'official', triggerReason: 'lineup_confirmed_auto' })`. All existing decisions (`official-published`, `same-hash-no-op`, `official-superseded`, `locked-skip`, `post-first-pitch-skip`) map 1:1 to the spec actions.
4. If status just transitioned to live, call the same atomic lock path the existing `/api/public/hooks/lock-live-forecasts` route uses, then log `locked_at_first_pitch`. If there is no active official run at that moment, log `no_official_forecast_before_start`.

The orchestrator never simulates directly — every write goes through `publishForecastIfEligible`, which already enforces eligibility, first-pitch cutoff, locked-skip, same-input-hash no-op, and supersede semantics. Preview rows are untouched.

## Phase 2 — Lifecycle log persistence

New table `public.automation_log` (migration):

- `id uuid pk default gen_random_uuid()`
- `game_id uuid`, `game_pk bigint`, `date date`, `scheduled_start timestamptz`
- `game_status text`, `home_lineup_count int`, `away_lineup_count int`, `starters_confirmed int`
- `action text` constrained to the 8 allowed values
- `result text`, `forecast_run_id uuid null`, `model_version text null`, `input_hash text null`
- `checked_at timestamptz default now()`

`GRANT SELECT` to `authenticated`, `ALL` to `service_role`. Enable RLS; one policy gates `SELECT` to admins via the existing `has_role(auth.uid(), 'admin')`. The orchestrator writes via `supabaseAdmin`. The Lifecycle log replaces ad-hoc `console.log("[forecast.lifecycle]", …)` for the actions listed; the structured console log lines stay for ops visibility.

## Phase 3 — Live actuals worker

New server route `/api/public/hooks/refresh-live-actuals` plus a `runLiveActualsRefresh(date)` worker. For each game whose status is live / in-progress, it pulls `boxscore` + `linescore` from MLB Stats API and upserts into the existing `projection_results` / score columns. It explicitly does not touch `forecast_runs`, `projections`, `forecast_consensus`, `sim_snapshot`, model_version, input_hash, or any timestamp on those rows. Writes one `actuals_refreshed` lifecycle row per game touched.

The existing client-side 45 s polling on `/today/live` and `/odds` stays as a read-side refresh of the now-server-driven actuals — no writes from the client.

## Phase 4 — Cron schedules

Three pg_cron jobs replacing the current `refresh-lineups-window-a/b`:

- `slate-orchestrator-active`: `*/2 11-23 * * *` UTC (Chicago ~06:00–18:00 covers pregame and afternoon games) → POST `/api/public/hooks/orchestrate-slate`.
- `slate-orchestrator-night`: `*/2 0-6 * * *` UTC (covers late west-coast games and overnight finals) → same endpoint.
- `live-actuals`: `*/1 * * * *` → POST `/api/public/hooks/refresh-live-actuals`.

The existing `lock-live-forecasts` minute job stays as a redundant safety net since lock-at-first-pitch is also done inside the orchestrator.

All three endpoints sit under `/api/public/hooks/*`, authenticate via `Authorization: Bearer ${CRON_WEBHOOK_SECRET}` (timing-safe compare, matching the pattern already in `refresh-lineups.ts`), and call the same shared functions the manual admin button calls.

## Phase 5 — Admin status surface

- `getCronStatus` server fn extended to also return the most recent `automation_log` row per game id for today, plus `forecast_runs.locked_at` and `forecast_runs.version_number`.
- Admin `Lineup Status` page gets one extra column block per game: latest automation check / action / result, current model version, publication timestamp, lock timestamp, and a green/red "forecast window open" badge driven by `gameHasStartedOrPastStart`.
- The existing manual `refreshLineupsAndProject` button is renamed `Run Slate Automation Now` and rewired to call `orchestrateDiamondSlate(today)` — the same path the cron uses. No separate manual engine path.

## Phase 6 — Tests

Add `src/lib/automation/__tests__/orchestrator.test.ts` (Vitest) covering each spec test by stubbing `supabaseAdmin` and the MLB fetcher:

1. Eligible game with no prior run → exactly one `publishForecastIfEligible` call, one `official_published` log row.
2. Second orchestrator run with unchanged inputs → no new `forecast_runs` row, one `official_noop_same_hash` log row.
3. Pregame lineup mutation → one supersede + one new `version_number = N+1` row, log `official_superseded_pre_pitch`.
4. Game transitions to live with active run → atomic lock, one `locked_at_first_pitch` row, forecast field hash unchanged.
5. Game already live and orchestrator called → no new `forecast_runs` row regardless of class, log `forecast_window_closed`.
6. Live actuals worker called 20×; locked `forecast_runs` row byte-equal across calls (deep object hash).
7. Public read paths (`getForecastBoard`, `getConsensus`, `getOdds`) mocked router-style — confirm none call any `*.functions` writer or simulator helper.
8. Game with no official by first pitch → no late publish even when lineups arrive after `gameHasStartedOrPastStart` is true; one `no_official_forecast_before_start` row.

## Out of scope this turn

Calibration changes, Consensus v2 promotion, UI redesigns, model math, snapshot format. Pure orchestration plumbing on top of the existing locked lifecycle.

## Technical notes

Files added:
- `src/lib/automation/orchestrator.ts`
- `src/lib/automation/live-actuals.ts`
- `src/lib/automation/window-guard.ts` (exports `assertForecastWindowOpen` + `ForecastWindowClosedError` wrapping existing `gameHasStartedOrPastStart`)
- `src/routes/api/public/hooks/orchestrate-slate.ts`
- `src/routes/api/public/hooks/refresh-live-actuals.ts`
- `src/lib/automation/__tests__/orchestrator.test.ts`
- One Supabase migration creating `public.automation_log` (table + GRANTs + RLS + admin SELECT policy + indexes on `game_id`, `checked_at`, `action`).

Files edited:
- `src/lib/lineups/refresh.functions.ts` — extract `refreshGameState`, keep `runRefresh` for backward compat but route it through `orchestrateDiamondSlate`.
- `src/lib/forecast/lifecycle.ts` — add lifecycle log writes alongside existing `console.log("[forecast.lifecycle]", …)` lines. No change to decision rules or return values.
- `src/routes/_authenticated/_admin/lineup-status.tsx` — add automation columns and rename the manual button.
- pg_cron migration replacing `refresh-lineups-window-a/b` with the three new schedules above; old job names unscheduled in the same migration.

No changes to: `src/lib/engines/*`, `src/lib/sim.functions.ts`, `src/lib/sim-snapshot.ts`, `src/lib/consensus.ts`, `src/lib/forecast/eligibility.ts`, `src/lib/forecast/window.ts` core logic, model_versions, or any read-side route loader contract.
