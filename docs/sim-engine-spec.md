# Diamond Simulation Engine — Phase 3b Specification

Status: DRAFT · Owner: TBD · Supersedes: none · Replaces: `simulateChunkPlaceholder` in `src/lib/sim-queue/worker.server.ts`

## 0. Scope and non-goals

The Phase 3b engine replaces **only** the per-chunk simulator. It MUST preserve:

- the `sim_jobs` / `sim_job_chunk_runs` queue contract,
- the `sim_player_outputs` schema and its unique `(sim_job_id, player_id, market)` key,
- lease handling, retry, timeout, resumability, and `chunk_progress` shape,
- the current/stale flip on `inputs_hash` change,
- the immutability of already-locked snapshots (never rewritten in place).

Only when this engine ships does `engine_status` flip to `validated`. Until then every run stays `scaffold_unvalidated` and every downstream consumer excludes those rows.

## 1. Hitter plate-appearance & event-rate model

Per-PA outcome categories: `K, BB, HBP, HR, 3B, 2B, 1B, OUT_in_play`. Rates come from a shrunk player prior blended with the pitcher's shrunk profile via log5 against a per-season league baseline. Handedness split (vs. L / vs. R) is stored separately per player and blended by the batter–pitcher hand pair actually faced. Missing hand-split samples fall back to overall rate with proportionally lower reliability weight.

Contact vs. non-contact split is enforced: `K + BB + HBP + HR + BIP_hits + BIP_outs = 1`. `BIP_hits` (1B/2B/3B) share is modeled as a function of `xwOBAcon` prior (batter) × `xwOBAcon_allowed` prior (pitcher) × park BIP factor, then normalized. Batted-ball type (GB/FB/LD) is tracked as a latent variable used by park & weather adjustments but not persisted per PA.

## 2. Pitcher / batter interaction

log5 with league anchor:
`p(event) = (b·p / L) / ((b·p / L) + (1−b)(1−p) / (1−L))`,
per event, per hand pair, before park/weather multipliers. Pitcher rates split by starter vs. per-role bullpen aggregate (LHP-relief, RHP-relief, closer). Same-batter-order times-through-the-order penalty is applied to the starter's `K` and `xwOBAcon_allowed` per TTO tick.

## 3. Lineup order & expected-PA model

Innings simulated as full 9 (or extras) half-innings. Each half-inning walks the batting order deterministically from the state at the previous half-inning's last batter. Outs advance from base–out state transitions (24-state table). Expected PA per lineup slot emerges from simulation rather than a closed-form formula. Pinch-hit / double-switch handling is out of scope for v1 (documented limitation; reliability lowered accordingly).

## 4. Park & weather effects

Multiplicative on per-PA rates, applied after log5, before normalization:

- Park: HR, 2B, 3B, BIP-hit multipliers by hand. Ballpark constants updated pre-season, cached in `park_factors`.
- Weather: temperature, wind vector projected onto park orientation, humidity, precip probability. Wind out ≥ 8 mph lifts HR rate; wind in lowers it; hot/humid lifts HR. Precip probability > threshold flips a `rain_delay_risk` flag but does not shrink event rates (game either plays or is postponed — postponement voids the run).

Weather threshold buckets are stricter than the schedule engine (see `WEATHER_BUCKET` in `enqueue.server.ts`); crossing any bucket changes `inputs_hash` and triggers a fresh 20K.

## 5. Bullpen & game-state effects

Starter workload allocated by expected batters faced (function of pitch count prior, TTO penalty, and manager hook curve). Once the starter exits, the bullpen assignment is drawn from a team-specific reliever mix conditioned on inning + score margin (leverage index bucket). Closer usage requires save situation in innings 9+. Extra innings use a "next best available" heuristic.

## 6. Recent-form shrinkage & decay

Two-window shrinkage against a season prior:

- Hitter: last 14 days of PAs, weighted with exponential half-life of 7 days. Shrinkage weight `w = n_recent / (n_recent + k)` with `k = 60 PAs` (hitters), `k = 25 BF` (pitchers).
- Only per-event rate deltas are shrunk. `baseline_mean` / `baseline_event_probability` are stored WITHOUT the shrunk delta so Form Movers can compute a clean adjustment vector.
- `form_reliability` reported per player = `min(1, n_recent / k_full)` where `k_full = 120 PAs / 50 BF`.

## 7. Correlation rules within shared game paths

Within one iteration, PAs are drawn conditionally on the persistent lineup state — this induces the correct within-game correlations for hits/runs/etc. without an explicit copula. Cross-player metrics (e.g. team-total × player-total) inherit consistency because they share the same simulated game. **No cross-game correlation is modeled**; each game runs its own MC chain with its own seed.

## 8. Calibration targets, backtesting, versioning

- Calibration targets: MLB league-season KDE for each event probability; per-market Brier score on out-of-sample slates ≤ current benchmark.
- Backtest harness: replays historical slates through the engine using only pre-lineup info, compares to actuals via `projection_results`. Ships as `src/lib/sim/engine.backtest.ts` (new).
- Versioning: `model_version` string embedded on every `sim_player_outputs` row. Bump on any change to rates, blend, park/weather multipliers, shrinkage constants, or bullpen model. Old rows stay readable.

## 9. Uncertainty & failure / fallback

- Uncertainty: reported as MC standard error of the event probability plus a coverage flag (`n_recent >= k_full`). The scaffold's naive `confidence = 1 − 6·stderr` is replaced by a per-market table calibrated on backtests.
- Fallbacks: if a required input is missing (lineup incomplete, unknown starter, unknown park), the engine refuses to run and the job is marked `failed` with a machine-readable `last_error`. The queue does NOT silently downgrade to a placeholder. The 2K preview tier may run with weaker inputs but must still refuse when inputs are absent.
- Timeouts: preserved from the queue (per-chunk wall clock). A chunk that trips the timeout is retried at the job level; retries exhausted → `failed`.

## 10. Replacement contract

The engine module MUST export:

```ts
export function simulateChunk(job: SimJobRow, chunkIndex: number, players: RosterPlayer[], state: EngineState): void;
export function finalizeState(job: SimJobRow, state: EngineState): SimPlayerOutputRow[];
```

with `EngineState` opaque to the worker. The worker will construct a fresh `EngineState`, apply completed chunks from `chunk_progress`, run new chunks, and pass the final state to `finalizeState`. Only `finalizeState` may set `engine_status = 'validated'` — and only after passing the calibration & backtest gates.
