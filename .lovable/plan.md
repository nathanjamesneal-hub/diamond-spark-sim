## Top 25 Simulation Leaders

Repurpose `/odds` into a leaderboard ranked by **existing Monte Carlo mean outputs** from the sim engine. No changes to the engine, scoring, or probability math — pure UI + a thin, pass-through server aggregator.

### Scope

- Replace `src/routes/odds.tsx` content (keep the `/odds` path so existing links don't 404; rename is an easy follow-up).
- Remove sportsbook/odds language and the value-board UI. Leave `src/lib/odds.functions.ts` untouched (still used by other pages).
- Header: "Top 25 Simulation Leaders" / subtitle "Ranked from existing Monte Carlo simulation outputs."

### Data source — strict pass-through

New server function `getSimulationLeaders({ date })` added to `src/lib/sim.functions.ts`.

**Hard guardrail:** this function may only call existing functions and reshape their returned values. It will not:

- introduce new formulas, weights, or probability conversions,
- derive probabilities from means or scores,
- invent thresholds the engine doesn't already expose,
- compute any new simulated stat.

What it does:

1. Calls existing `getDiamondScores({ data: { date } })` to get the slate's hitter/pitcher cards (identity, lineup status, badge, opponent, diamond_score, confidence, and the probability fields already persisted on the projection).
2. For each game on that slate, calls existing `simulateGame({ data: { gamePk } })` and reads the per-batter `BatterDist` / per-pitcher dist objects exactly as the matchups page already does.
3. Joins by `mlb_id` (and game) and reshapes into two arrays:
   - `hitters: SimLeaderHitterRow[]`
   - `pitchers: SimLeaderPitcherRow[]`
4. For every field — mean, stdev, p50, p90, any threshold probability — if the source value isn't on the dist or the card, the field is `null`. No fallbacks. No conversions.

Row shape (illustrative — all numeric fields nullable):

```text
SimLeaderHitterRow {
  player_name, mlb_id, team_abbrev, opp_abbrev, game_id,
  batting_order, lineup_status, badge,
  diamond_score, confidence,
  H:    { mean, stdev, p50, p90, probAtLeast1, probAtLeast2 } | null,
  HR:   { mean, ..., probAtLeast1 } | null,
  RBI:  { mean, ..., probAtLeast1 } | null,
  R:    { mean, ..., probAtLeast1 } | null,
  TB:   { mean, ..., probAtLeast2 } | null,
  SB:   { mean, ..., probAtLeast1 } | null,   // present only if engine exposes it
  K:    { mean, ..., probAtLeast1 } | null,   // batter K
}

SimLeaderPitcherRow {
  player_name, mlb_id, team_abbrev, opp_abbrev, game_id,
  diamond_score, confidence, lineup_status, badge,
  outs:  { mean, p50, stdev, p90 } | null,
  K:     { mean, p50, stdev, p90 } | null,
  BB:    { mean, ... } | null,
  ER:    { mean, ... } | null,
  win_probability:           number | null,  // pass-through from card
  quality_start_probability: number | null,  // pass-through from card
  // future probability fields read by key from the dist when present;
  // missing keys stay null.
}
```

Cached per (date, lineup signature) the same way `simulateGame` already is.

### Page UI (`src/routes/odds.tsx`)

- Tabs/sections in this order: Hits, Home Runs, RBI, Runs, Total Bases, Stolen Bases, Batter Strikeouts, Pitcher Strikeouts, Pitcher Outs, Quality Start, Pitcher Win.
- Per category:
  - Top 25 rows.
  - Default sort: that category's **mean** desc; secondary sort by the matching threshold probability when present, else by `diamond_score` desc.
  - If zero rows have a real mean for that category, the section is hidden by default and shows "No simulation data available for this category." when the user filters to it.
- Columns: Rank · Player (links to `/players/$mlbId`) · Team · Opp · **Mean** · **Sim Prob %** (or `—`) · Diamond Score · Confidence · Lineup Status · Drivers ("Why" using the existing `WhyTheModelLikesThis`, only when its inputs are present).
- Reuse `SimMethodologyTooltip` on the page header and on the Mean / Sim Prob column headers with the exact required copy.
- Filters: Team filter and a lineup-status filter (Locked / Verified / Waiting). No min-% slider — mean-based ranking doesn't need it.

### Future pitcher probability readiness

The page declares an extensible list of pitcher probability fields it knows how to render: `win`, `quality_start`, `k_over_5`/`6`/`8`/`10`, `outs_over_X`, `er_zero`, `er_over_1`/`2`/`3`/`4`, `lasts_5`/`6`/`7`. For each pitcher row it reads those keys from the row payload; missing keys render `—`. When the engine starts emitting them, `getSimulationLeaders` will pass them through unchanged and the UI lights up — no math added in the UI, no new code.

### Safety

- No edits to `src/lib/engines/**`, `src/lib/sim/engine.ts`, `runDiamondEngineForGames`, `simulateGame`, or any scoring/probability math.
- `getSimulationLeaders` is a thin orchestrator: existing functions in, reshaped DTO out, `null` whenever a field is absent.
- `getOdds` stays in place for other consumers.
- Site header link relabeled "Odds" → "Sim Leaders" (path unchanged).

### Out of scope

- Renaming `/odds` to `/sim-leaders`.
- Persisting sim distributions to a DB table to skip per-load recomputation (today it re-runs sims per slate, cached in-memory).
