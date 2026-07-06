## Diamond Leaderboards — Form Movers + Prop Leaders + Consensus

Two-layer leaderboard system that reads from the completed 20K Official Lineup Run once per game. Depends on the sim-queue Phase 3 worker and its per-player output table — neither exists yet — so this plan is spec + schema now, code after the worker lands.

### Dependencies (must exist first)

- `sim_jobs` — done (Phase 1).
- `sim_worker` route + `sim_player_outputs` table — Phase 3, not started. This is where per-player projected means, event probabilities, and uncertainty come from. All leaderboards read from that table filtered to the current eligible run per game (`tier='20k'`, current `inputs_hash`, `status='completed'`).
- Optional: a market snapshot table (sportsbook lines + timestamps). We already have `petri_player_market_snapshots`; the Prop Leader flow will reuse it. If it's missing required fields for a market, that market silently degrades to Projection Leader.

Nothing in this plan touches locked snapshots, changes engine math, or ships new public forecast semantics until the worker fills `sim_player_outputs`.

### New schema

Two additive tables. Both admin-read, service-role write.

**`sim_player_outputs`** — Phase-3 dependency, listed here so the leaderboard queries are pinned:
```
sim_job_id, game_id, slate_date, player_id, side ('bat'|'pit'),
proj_mean jsonb,        -- e.g. { hits: 1.02, tb: 1.71, hr: 0.14, ... }
event_probs jsonb,      -- e.g. { "1plus_hit": 0.71, "2plus_hits": 0.31, "hr": 0.14, ... }
uncertainty jsonb,      -- per-event stderr + a scalar confidence_0_1
recent_form jsonb,      -- { sample_pa, shrinkage_weight, contribution_by_event }
inputs_hash, model_version, sim_count, completed_at
```

**`leaderboard_snapshots`** — the materialized boards, one row per (slate, board, market, player):
```
slate_date, board ('form_movers'|'projection_leaders'|'prop_leaders'|'diamond_consensus'),
market text,              -- 'form_mover' | '1plus_hit' | '2plus_hits' | 'total_bases' | 'hr' | 'rbi' | 'runs' | 'sb' | 'k' | 'outs' | 'er' | 'hits_allowed' | 'consensus'
threshold numeric,        -- market threshold when applicable
game_id, player_id, side,
sim_job_id, inputs_hash, sim_tier ('20k'|'2k'),
label ('form_mover'|'projection_leader'|'qualified_prop_leader'|'watchlist'|'not_eligible'),
projected_mean numeric, event_probability numeric, confidence numeric,
fair_odds_american int, fair_odds_decimal numeric,
book_line numeric, book_price_american int, book_source text,
novig_implied_prob numeric, prob_delta numeric,
edge_score numeric,        -- confidence-adjusted edge used for ranking
form_adjustment numeric, form_direction ('riser'|'neutral'|'faller'),
form_sample_size int, form_reliability numeric,
prior_run_delta numeric,   -- vs previous eligible run for this (game,player,market)
driver_summary text,       -- plain-language, generated from the top contributors
market_timestamp timestamptz, freshness_seconds int,
locked bool, snapshot_id uuid,  -- pregame lock reference when applicable
rank int, computed_at timestamptz
```

Unique per (slate_date, board, market, player). Recomputed after each completed 20K run for that game.

### Layer A — Form Movers

Trigger: whenever a game gets a new completed 20K run for the current `inputs_hash`, recompute Form Movers for the players in that game and re-rank the slate list.

Per eligible hitter/pitcher, compute against `sim_player_outputs`:

- `projected_mean` and `event_probability` from the completed 20K run
- `baseline_mean` — the same projection recomputed with `recent_form.contribution_by_event` zeroed out (already recorded by the sim; not a re-sim)
- `form_adjustment = projected_mean − baseline_mean`
- `form_direction`: `riser` if adjustment ≥ +τ, `faller` if ≤ −τ, else `neutral` (τ per-market; e.g. hits 0.08, K 0.4)
- `form_sample_size` — PA/BF used in the form window
- `form_reliability` = shrinkage weight actually applied (0..1), directly from the sim's shrinkage
- `prior_run_delta` — delta vs the last leaderboard_snapshot for this (game,player) pair
- `confidence` — from sim uncertainty (higher stderr → lower confidence)

**Ranking score for Form Movers:**
```
mover_score = |form_adjustment_z| * form_reliability * confidence * freshness_factor
```
- `form_adjustment_z` = adjustment normalized against the market's typical daily stddev
- `freshness_factor` decays linearly from 1.0 at run completion to 0.4 at T-20 (lock deadline)
- Hard filters that force `label='not_eligible'`: no confirmed lineup at eligibility check, `sim_tier != '20k'` current, `form_sample_size < market_min_pa`, `sim_status != 'completed'` for current hash

This ranking guarantees a one-good-game bump can't top the list: `form_reliability` is the sim's shrinkage weight — a 5-PA sample is heavily shrunk, so `form_adjustment` and reliability are both small.

Driver summary generation (deterministic, no LLM): pick the top 2 contributors from `recent_form.contribution_by_event` and phrase them with fixed templates ("Contact quality trending up over last 45 PA; matchup vs RHP boosts HR odds").

### Layer B — Projection Leaders / Prop Leaders

For every supported market, we compute one leaderboard per slate:

- `1plus_hit`, `2plus_hits`, `total_bases` (0.5/1.5/2.5), `hr`, `rbi`, `runs`, `sb` (when eligible per-lineup context), `k` (pitcher), `outs` (pitcher), `er` (pitcher), `hits_allowed` (pitcher).

Each supported market has: default threshold, `market_min_pa`/`market_min_bf`, and a "typical stddev" constant for normalization.

**Per candidate, always store:**
player, game, market, threshold, `projected_mean`, `event_probability`, `confidence`, `fair_odds`, `form_adjustment`, driver summary (matchup + environment + form), `sim_tier`, `inputs_hash`, `completed_at`, `locked` + snapshot_id when a lock exists.

**Label decision (deterministic):**

1. Missing confirmed lineup / stale sim / insufficient data / `sim_status != 'completed'` → `not_eligible`.
2. Sim OK, but no matching current market row in `petri_player_market_snapshots` (or freshness > 15 min, or book absent for this player+market) → `projection_leader`. Rank by `event_probability * confidence * freshness_factor` inside that market's board.
3. Sim OK and a current market row exists → compute `no_vig_prob`, `prob_delta = model_prob − no_vig_prob`, and:
   - Qualification checks (all must pass): freshness ≤ 15 min, both sides of the market present for de-vig, model uncertainty within band, 2K→20K probability delta for this player+market ≤ instability threshold (default 0.06 absolute).
   - Passes → `qualified_prop_leader`.
   - Fails → `watchlist` with the failing check recorded in `driver_summary`.
4. Strong projection (top-N by `event_probability`) that failed qualification also lands on `watchlist`.
5. Form Movers board pulls its own rows independently.

**Confidence-adjusted edge (ranking score for Prop Leaders):**
```
edge_score =
    prob_delta                          -- raw model edge
  * confidence                          -- uncertainty penalty
  * freshness_factor                    -- staleness penalty (market + sim)
  * stability_factor                    -- 1 − |p20k − p2k| / instability_cap, floored at 0
  * form_reliability_penalty            -- 1 for reliability ≥ 0.5, linear to 0.5 at reliability 0
  * market_completeness_factor          -- 1 if both sides + recent tick, 0.7 if partial
```

Never rank across markets in this layer. Each market has its own list.

**Fair odds:** derived directly from `event_probability` (American + decimal, both stored). Never from raw form.

### Layer C — Diamond Consensus

Only `qualified_prop_leader` rows are eligible. Cross-market ranking:

```
consensus_score =
    edge_score
  * projected_opportunity_factor        -- e.g. PA/BF vs market baseline
  * form_reliability
  * data_freshness
```

Top-N per slate. The exact `event_probability`, `edge_score`, `sim_job_id`, `inputs_hash`, and market snapshot (line + price + timestamp) are copied into `leaderboard_snapshots` so a later graded outcome is judged against exactly what the leaderboard showed.

### Compute + refresh flow

1. Sim worker completes a 20K run for a game → inserts `sim_player_outputs` rows.
2. Fires `recompute_leaderboards_for_game(game_id)` (server function).
3. That function:
   - Recomputes Form Movers rows for that game's players.
   - For each supported market, recomputes candidates for that game, joins with the latest `petri_player_market_snapshots`, applies the labeling ladder, computes `edge_score`.
   - Upserts into `leaderboard_snapshots` scoped to that game (other games' rows untouched).
   - Recomputes Diamond Consensus for the slate (cheap join over qualified rows).
4. Admin can trigger a full slate rebuild via a server function; not on a cron.

Locked snapshots are read-only inputs — leaderboards never mutate them.

### Admin surfaces (later, once data exists)

- `/admin/leaderboards` — tabs: Form Movers, per-market boards, Diamond Consensus. Filter by slate. Each row shows all stored fields + label. Not on the public site yet.
- Slate Reconciliation panel gains a "Leaderboard status" column: per-game count of eligible/ineligible players and time of last recompute.

### Non-goals

- No changes to public odds/edge/consensus/movers surfaces already shipped.
- No new ML/LLM anywhere in the ranking; every score is a deterministic function of sim + market fields.
- No cross-market raw-probability ranking anywhere except the deliberately labeled `diamond_consensus` board.
- No changes to Engine Beta locking, autolock timing (still T-20 from the sim plan), or grading semantics.

### Sequence question — please confirm before I write any code

The leaderboards can't be computed until `sim_player_outputs` exists, which is the sim worker's job. Options:

1. **Recommended:** finish sim-queue Phase 3 (durable worker + `sim_player_outputs`) first, then ship leaderboard schema + compute + admin UI in one clean pass on real data.
2. Ship the `leaderboard_snapshots` schema and compute skeleton now against a synthetic/`sim_player_outputs`-shaped fixture, so the admin table renders empty rows this week.
3. Ship the compute + admin UI now against the existing engine outputs (Petri/Engine Beta) as a bridge, then rewire to `sim_player_outputs` when the worker ships.

Option 3 means throwaway rewiring later; option 2 renders empty tables until the worker exists. Option 1 is the cleanest.
