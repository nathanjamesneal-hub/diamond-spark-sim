# Petri v0.2 Shadow Lab — Implementation Plan

A fully isolated admin-only shadow simulation system. Zero changes to Alpha 0.3, Forecast Board, Diamond Score, Consensus, Top Props, Results, grading, cron jobs, or public surfaces.

## 1. Database (new tables, Petri-only)

Migration creates two tables under `public`, both admin-read/service-write only — no anon access, no policies that intersect with existing forecast tables.

`petri_forecast_runs`
- `id uuid pk`
- `game_pk bigint not null`
- `game_date date not null`
- `model_version text not null default 'petri-v0.2-shadow'`
- `status text not null` — `preview | locked | skipped | abstained`
- `seed bigint not null`
- `iterations int not null`
- `input_hash text not null`
- `input_source_map jsonb not null` — paths + table refs used
- `data_completeness jsonb not null` — per-input score
- `fallbacks jsonb` — `[{path, source, reason, confidence_impact}]`
- `abstention_reasons jsonb`
- `locked_at timestamptz`
- `created_at timestamptz default now()`

`petri_player_market_snapshots`
- `id uuid pk`
- `run_id uuid fk → petri_forecast_runs(id) on delete cascade`
- `game_pk bigint not null`
- `player_id bigint not null` (MLB id)
- `team_id bigint not null`
- `role text not null` — `hitter | pitcher`
- `lineup_slot int` — 1–9 for hitters, null for pitchers
- `is_confirmed_starter boolean` — pitchers
- Hitter metrics: `h_mean, h_p10, h_p50, h_p90, hit_1plus, tb_mean, tb_p10, tb_p50, tb_p90, tb_2plus, hr_mean, hr_p10, hr_p50, hr_p90, hr_1plus, hitter_k_mean, hitter_k_p10, hitter_k_p50, hitter_k_p90, pa_mean`
- Pitcher metrics: `pk_mean, pk_p10, pk_p90, outs_mean, outs_p10, outs_p90, bf_mean`
- `source_map jsonb not null`
- `data_completeness numeric`
- `raw_probability_label text default 'Shadow raw probability — not yet calibrated'`
- `calibrated_probability numeric` — always null at insert
- `created_at timestamptz default now()`

Indexes: `(game_pk, run_id)`, `(run_id, role)`, unique `(run_id, player_id, role)`.

RLS: enable. Policies:
- `SELECT` to `authenticated` only when `has_role(auth.uid(), 'admin')`.
- `ALL` to `service_role`.
- No `anon` grants.

## 2. Engine (new files only)

```
src/lib/petri/
  ├── engine.ts                 # Seeded Monte Carlo (10k iters) — hitter + pitcher
  ├── inputs.ts                 # Pulls inputs from app data; builds source_map + completeness
  ├── eligibility.ts            # Gate: game not started, lineup 1–9, confirmed starter, etc.
  ├── hash.ts                   # Stable input hash (sha256 of canonical JSON)
  ├── rng.ts                    # mulberry32 seeded RNG
  └── run.functions.ts          # createServerFn: runPetriShadowForUnstarted()
```

Engine details:
- Seeded RNG per game: `seed = hash(game_pk, model_version, input_hash) mod 2^31`
- 10,000 sims per game
- Per-PA exclusive outcome resolution: K / BB+HBP / OUT-in-play / 1B / 2B / 3B / HR — blended from batter rate × pitcher rate × league baseline (log5), scaled by venue when available
- Hitter PA opportunity derived from lineup slot + projected team runs context (if any) + starter expected workload
- Pitcher outs/BF derived from confirmed starter context + opponent confirmed lineup quality
- Abstain instead of guess: any required input missing → record reason, status = `abstained`
- Document fallbacks explicitly (e.g., "no team-runs context → league avg lineup turnover ~37.8 PA / 9")

Server fn `runPetriShadowForUnstarted` (admin-only via `has_role` check inside handler):
1. Resolve today's date in America/Chicago via `todayInAppTz`
2. List today's games with status not in (started/live/final)
3. For each game: build inputs, check eligibility, hash inputs, simulate or abstain, persist run + snapshots
4. Return summary: `{ eligibleGames, generated, abstained: [{gamePk, reason}], hitterSnapshots, pitcherSnapshots }`

Separate small fn `lockPetriRunsForStartedGames` flips `preview → locked` and sets `locked_at` once first pitch has passed. Called inline at the end of the run, never from cron.

Read fns (admin-only): `getPetriRunsForDate(date)`, `getPetriRunDetail(runId)`.

## 3. Admin UI

New file `src/routes/_authenticated/_admin/petri.tsx` registered under the existing admin layout (already role-gated).

Layout:
- Header: **Petri v0.2 Shadow Lab** + persistent banner *"Petri v0.2 Shadow — Not Public / Not Calibrated"* on every panel
- Primary button: **Run Petri Shadow — Unstarted Games** (calls server fn via `useServerFn` + `useMutation`)
- Date selector (defaults to today CT)
- Summary cards: eligible / generated / abstained / skipped / locked
- Games table: gamePk, matchup, status (eligible/generated/locked/skipped/abstained), seed, iterations, input hash (short), data completeness, "View Details"
- Detail drawer (lazy): tabs Hitters / Pitchers / Inputs
  - Hitter table: name · slot · H mean · Hit 1+ · TB mean · TB 2+ · HR mean · HR 1+ · PA mean · completeness
  - Pitcher table: name · K mean (P10/P90) · outs mean (P10/P90) · workload context · completeness
  - Inputs tab: seed · iterations · input hash · source map JSON · fallbacks · abstention reasons

Add an Admin nav link entry pointing at `/petri`. No public surface ever links to it.

## 4. Isolation guarantees

- New tables only; no FK to or write to existing `forecast_runs`, `forecast_player_projections`, `projections`, `forecast_consensus`
- No imports from Alpha 0.3 engine, consensus, sim-metrics, or grading
- No edits to: orchestrator, refresh, ingest, sim.functions, projections.functions, model-results, calibration, results, top-props, odds, diamond-consensus, forecasts.*, forecast-board components
- No new cron job; Petri only runs from the admin button
- Petri snapshots never feed `selectBestPublicForecast`, Consensus v1/v2, Top Props, or Sim Leaders

## 5. First-run report

After deploying, run the button against today's CT slate and report:
- eligible / generated / abstained (with reasons) / hitter snapshots / pitcher snapshots
- one full hitter example (source paths, fallbacks, seed, input hash, means/percentiles, Hit 1+, TB 2+, HR 1+, completeness)
- one full pitcher example (same fields plus K mean/range, outs mean/range)
- confirmation that Alpha 0.3 tables and routes were untouched (file diff list)

## Technical notes

- Hash inputs with `crypto.createHash('sha256')` over canonical-sorted JSON
- Seeded RNG via `mulberry32(seed)` (already used in Alpha sim, but copied into `src/lib/petri/rng.ts` so Petri owns its copy)
- All Petri DB writes go through `supabaseAdmin` loaded inside handlers
- Admin auth: `requireSupabaseAuth` middleware + `has_role(userId, 'admin')` check at top of every Petri server fn
