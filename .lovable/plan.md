## Goal

Rework `/calibration-lab` into a "Model Results" page that leads with plain‑English Mean Projection Accuracy, with Probability Calibration as a separate second section. Also add a Top 25 / All Qualified scope toggle to `/odds` (Sim Leaders).

No changes to engines, simulations, scoring, probability math, calibration math, data fetching, schemas, or routes. Aggregation + labeling + display only.

---

## Part 1 — Rename + restructure `/calibration-lab` into "Model Results"

File: `src/routes/calibration-lab.tsx` (keep route path; update page chrome, head meta, and layout).

Page title: **Model Results**
Subtitle: *How Diamond's finalized simulation projections performed against actual box scores.*

Two stacked sections, never mixed:

### Section A — Mean Projection Accuracy

Data source (new, display-only aggregation):

- For the selected date(s), call `getSimulationLeaders` (already used by `/odds`) to get every player's mean projections per category, plus `getActualsForDate` for finalized box-score actuals.
- New helper module `src/lib/model-results.ts` (pure functions, no server fn) that takes the leaders payload + actuals payload and returns per-category aggregates.

Categories graded as count-stats:

- Hitters: Hits, Total Bases, RBI, Runs, Batter Strikeouts (K)
- Pitchers: Strikeouts (K), Outs, Walks (BB)

Qualification + grading rules (exactly as specified):

- A row is *qualified* only if: game Final, actual exists, mean exists, `mean >= 0.5`.
- `target = Math.max(1, Math.round(mean))`
- `actual >= target + 1` → **Beat Projection** (strong green)
- `actual === target` → **Met Projection** (green)
- `actual === target - 1 && actual > 0` → **Close** (amber)
- `actual === 0` → **Missed** (red) — never green, never counted as success
- all other lower → **Missed** (red)
- For rows with `mean < 0.5`: actual `0` → *Low Projection / No Event* (gray), actual `>0` → *Unexpected Event* (amber/red). Both excluded from Met/Beat denominator; never count as a success.

Hero summary cards (computed from qualified rows only):

- Qualified Projections (count)
- Met or Beat (count + percentage of qualified)
- Close (count)
- Missed (count)
- Mean Absolute Error: `avg(|actual − mean|)`
- Avg Projection vs Actual: `avg(mean) → avg(actual)`
- Tooltip on the hero block: "Qualified projections have a mean of at least 0.5. A zero actual result never counts as a successful projection."

Category accuracy table:

- Columns: Category · Qualified · Met/Beat · Close · Missed · Hit Rate · Avg Mean · Avg Actual · MAE · Bias
- Hit Rate = (Met + Beat) / Qualified
- Bias = avg(actual − mean) (label "+ under-projection / − over-projection")
- Each row expandable into the underlying player rows: Player · Team · Mean · Target · Actual · Result (with player link + team-color styling reused from existing components).

Filters:

- Scope toggle: **All Qualified Projections** | **Top 25 Simulation Leaders Only**
  - "Top 25" mode reuses the same Top 25 slice the leaderboard already uses (per category, then union).
- Keep existing date/category/team filtering hooks where present; date already comes from `getActualsForDate` (defaults to Chicago today). Add a date input here if not already wired (read-only display, no business changes).

### Section B — Probability Calibration

Reuse the existing calibration grid (`getCalibration` + current `StatCard` / bucket table) untouched mathematically. Only relabel + reframe:

- Section heading: **Probability Calibration**
- Sub: *"Does a 70% model probability happen about 70% of the time over a meaningful sample?"*
- Keep current columns: Predicted, Observed, Hits / Sample, Δpp, n, Brier; keep version selector; keep "No HR Play" exclusion.
- Add a one-line note above the grid: "Actual 0 is always a miss; actual ≥ 1 is a hit. A zero actual is never counted as a successful prediction."

### Visual rules

- Green only for genuine Met/Beat outcomes.
- Amber for Close.
- Red for Missed.
- Gray for Low Projection / No Event.
- Existing dark MLB visual system, team colors, player links preserved.

Update `head()` title to "Model Results · Diamond" and refresh description.

---

## Part 2 — `/odds` (Sim Leaders) scope toggle

File: `src/routes/odds.tsx` only (no logic change in `src/lib/sim.functions.ts`).

- Add a URL-backed control `scope = "top25" | "all"` (default `top25`) using the existing `zodValidator`/`fallback` pattern alongside `cat`, `lineup`, etc.
- After existing filtering + sorting:
  - `top25`: `slice(0, 25)` (current behavior).
  - `all`: render every qualified row (row has a real mean for the active category — same qualification predicate used today to include a row, just without the slice).
- Result count display:
  - `top25` → "Top 25 of N qualified"
  - `all` → "N qualified players"
- Performance for `all`:
  - Render first 50 rows, then a **Load 50 more** button that appends batches client-side. Keep table wrapper, sticky header, horizontal scroll, team colors, player links unchanged.
- Keep category, team, lineup-status, sort controls and current Top 25 fast path visually prominent.

No changes to scoring, probability, calibration math, simulation, or data-fetch logic.

---

## Files touched

- `src/routes/calibration-lab.tsx` — restructure into Model Results (Section A + relabeled Section B). Keep route path.
- `src/lib/model-results.ts` (new) — pure aggregation/labeling helpers for Section A (qualification, grading, per-category summary, hero totals).
- `src/components/diamond/model-results/` (new, small) — `HeroSummary.tsx`, `CategoryTable.tsx`, `CategoryExpansion.tsx` for clarity; or inline into the route file if small.
- `src/routes/odds.tsx` — add scope toggle + count line + "Load 50 more" pager.

## Non-goals / safety

- Do not edit `src/lib/sim.functions.ts`, `src/lib/actuals.functions.ts`, `src/lib/projections.functions.ts` math, engines, or DB schema.
- Do not change route paths (URL stays `/calibration-lab`; nav label updates to "Model Results").

No new server functions, no new tables, no fabricated actuals.

## Accuracy integrity guardrails

### Historical prediction integrity

A Model Results record represents one **player + game + category** prediction made from pregame simulation output.

- Never re-run today’s model after a game is final and label the result as that day’s historical prediction if player rates, lineups, pitcher data, or inputs may have changed.
- Only grade dates where a matching pregame simulation snapshot / stored leader output is available.
- If historical simulation output is unavailable for a selected date, show:  
**“Simulation snapshot unavailable for this date.”**  
Do not reconstruct or fabricate a historical projection.
- Reusing existing query APIs in this route is allowed, but do not modify upstream fetching logic, schemas, simulation logic, or prediction math.

### Metric integrity

Do not blend raw Hits, Total Bases, and Pitcher Outs into one misleading global MAE or one global “Average Projection → Actual” number.

Instead:

- Calculate MAE and Bias per category exactly as specified.
- In the hero, show **Average Category MAE**: the equal-weight average of available category MAEs.
- Show projection-versus-actual separately for:
  - **Hitters**
  - **Pitchers**
- Keep the category table as the detailed source of truth.

### Scope integrity

For the **Top 25 Simulation Leaders Only** toggle:

- Use the same pregame category-specific sort and Top 25 selection used by `/odds`.
- Build the union from `player + game + category` rows, not unique players.
- A player appearing in Hits and Total Bases counts as two distinct projections because they are two distinct model outputs.
- Apply Top 25 selection before joining final actuals, so results cannot be influenced by what happened in the game.

### Missing-data rule

- Missing actual, missing mean, non-final game, or unavailable simulation snapshot means the row is excluded from Qualified Projections.
- Never substitute `0`, a fallback mean, or an inferred actual.

### Category boundary

Keep Home Runs and Stolen Bases in Probability Calibration unless there is a deliberately defined mean-projection accuracy framework for them later. They are event-style outcomes and should not inflate or distort the count-stat Met/Beat record.