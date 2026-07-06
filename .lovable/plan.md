## Official Simulation System — merged spec

Combines the earlier amendment (two-wave 20K: Early Slate + Confirmed refresh) with the fuller queue/model/diagnostics spec. Heavy simulation work is fully isolated from `orchestrate-slate` — the orchestrator only reads simulation status and enqueues jobs, never runs sims inline.

Nothing in this plan changes public forecast math, existing engine outputs, cron cadence, auto-lock policy semantics, Data Health cards, or Engine Beta admin behavior until the new tables/queue are populated and the board switches to them behind a flag.

### 1. Simulation tiers

- **2K Preview — provisional.** May run before lineups are confirmed. Useful for early context; never the preferred lock source when a valid 20K exists. Kept as lightweight fallback.
- **20K Early Slate — projected lineup inputs.** Queued per game as soon as: official schedule row, probable/confirmed starters, projected lineup + batting order with confidence metadata, park, weather, opponent, and recent-form inputs are all present. Target: complete several hours before first pitch. Never labeled as locked/final.
- **20K Confirmed Lineup — current inputs.** Queued when confirmed lineups arrive AND a material input actually changed vs the Early Slate input hash (hitter add/remove, order change, SP change, weather beyond threshold, opener/bullpen change). If nothing material changed, promote the existing Early Slate run as "current" rather than re-running 20K.

### 2. Model requirements (unchanged for existing engines; enforced for new runs)

- One coherent shared game path per iteration; hitter and pitcher outcomes derive from the same paths (no independent per-card sims).
- Inputs: long-term baseline, recent form (sample-size weighted, shrunk to baseline), handedness/matchup, projected lineup spot + PA, park, weather, bullpen/opponent context, confirmed starters/lineups when available.

### 3. Durable queue + worker

- New table `sim_jobs` (queued, running, completed, failed, cancelled, stale) with `game_id, slate_date, model_version, inputs_hash, tier (2k|20k), sim_count, seed, chunk_size, chunks_total, chunks_done, queued_at, started_at, completed_at, duration_ms, status, failure_reason, notes`.
- Idempotency key: `(game_id, model_version, inputs_hash, tier)`. Re-enqueueing the same key while queued/running is a no-op.
- Worker route `POST /api/public/hooks/sim-worker` (cron every minute, capped concurrency). Uses the existing per-stage lease pattern from the orchestrator fix so it cannot double-run or hang invisibly.
- 20K runs execute in 5 chunks of 4,000 with progress persisted after every chunk. On timeout/failure the row closes as `failed`/`timed_out` with `failure_reason`; never blocks other jobs and never touches the orchestrator lease.
- Cancellation: when a newer input hash arrives, older queued/running jobs for the same game+tier are marked `stale` (running jobs are asked to stop at next chunk boundary; already-completed runs are retained for audit).

### 4. Enqueue triggers (orchestrator changes are minimal)

`orchestrate-slate` gains one new stage `enqueue_sims` (budget ~10s) that, per game:

1. Computes the current `inputs_hash` from the same input snapshot used by the current engine.
2. If no 2K row exists for this hash → enqueue 2K.
3. If Early-Slate inputs are ready and no 20K row exists for this hash → enqueue 20K (tier `20k`, label `early_slate`).
4. If confirmed lineups arrived AND the hash differs from the last completed 20K's hash → enqueue 20K (label `confirmed`). Otherwise promote the Early Slate run's `label` to `current` without re-running.

The stage only writes to `sim_jobs`; it never invokes the sim engine.

### 5. Freshness + safety invariants

- Never start or refine simulations after first pitch (worker refuses when `now >= first_pitch_at`).
- Never mutate a locked pregame snapshot; regrading remains the read-only path.
- A material-change hash always produces a new job; older runs are marked `stale` but never deleted.
- Auto-lock stays on its existing schedule but changes its selector (see §6).

### 6. Auto-lock selection

New lock-readiness deadline: **T-25 minutes before first pitch** (configurable 20–30). At every autolock tick:

1. Pick the latest `completed` `20k` run whose `inputs_hash` equals the current input hash.
2. If none, pick the latest `completed` `20k` run for this game (any hash) and record `lock_reason = "Locked using latest completed 20K run; confirmed refresh incomplete."`
3. If still none and we're past T-2 (existing final lock window), fall back to the current engine's 2K path and record `lock_reason = "Fell back to 2K: no completed 20K run at lock time."`
4. Never silently downgrade to 2K when a valid 20K exists.

Public forecast, movers, and Diamond cards read the same "current eligible run" as lock — the badge (2K Preview vs 20K Official) is derived from `sim_jobs.tier` of the run backing that game.

### 7. UI clarity (Diamond board + Slate Reconciliation)

Per game, surface:

- Early 20K run completion time
- Projected lineup confidence at Early Slate hash time
- Confirmed lineup time
- Whether a Confirmed refresh was required, and which inputs changed (diff summary)
- Current eligible run (id, tier, hash short, completed_at)
- Locked run + `lock_reason`
- Failure reason if the latest attempt failed
- Badge on every card: `2K Preview` or `20K Official`

New diagnostic panel: 2K→20K comparison per player (probability + rank delta) for the current game.

### 8. Diagnostics wiring

The existing Slate Reconciliation admin panel adds columns:

- `sim.early_20k` (queued/running/completed/failed + completed_at)
- `sim.confirmed_20k` (same)
- `sim.material_change` (yes/no + diff summary when yes)
- `sim.current_tier` (`20K Official` / `2K Preview` / `none`)
- `sim.lock_source` (job id + lock_reason)

Data Health gets a new card:

- **Simulation queue** — jobs queued, running, completed today, failed today, oldest queued age, last worker heartbeat, per-stage p50/p95 duration.

### 9. Migration + rollout order (implementation, not this turn)

1. Create `sim_jobs` + supporting indexes; RLS admin-read only.
2. Ship `enqueue_sims` orchestrator stage in dry-run mode (writes rows, worker disabled) to validate hashing + trigger logic against a live slate.
3. Ship the worker route + cron, keep board/lock unchanged.
4. Flip a feature flag: board and auto-lock switch to `sim_jobs`-backed selection with the new tier badges.
5. Add UI badges, diagnostics panel additions, and 2K→20K comparison view.

### Non-goals

- No change to engine math, recent-form shrinkage, projection formulas, or Diamond Score weights.
- No change to public odds/edge/consensus/movers surfaces beyond adding tier badges and lock_reason.
- No changes to Engine Beta admin behavior.
- No changes to the July 5 reconciliation flow shipped this session.

### Open decisions (please confirm before implementation)

1. Lock-readiness deadline: 20, 25, or 30 minutes before first pitch?
2. Weather material-change threshold — reuse the existing engine threshold, or define a stricter one just for re-enqueueing 20K?
3. Chunk size for 20K: 5×4000 as specified, or fewer larger chunks (e.g. 4×5000) given Worker wall-time budgets?
4. Should the Diamond board show the `20K Official` badge only for the Confirmed run, or also for a promoted Early Slate run when no material change occurred?
