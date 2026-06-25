# Reposition Diamond as a Simulation Engine (UI-only)

Goal: present existing simulation outputs first, derived probabilities second. No changes to `src/lib/sim/engine.ts`, `src/lib/engines/**`, or any probability math.

## What we already have (and will reuse as-is)

- **Sim engine** (`src/lib/sim/engine.ts`): per-batter `BatterDist` with `mean`, `stdev`, `p50`, `p90` for H/HR/RBI/R/K/BB; per-pitcher `outs/k/er` dists; runs `DEFAULT_ITERS = 2000`. Currently consumed only by `matchups.$gamePk.tsx`.
- **Projections row** (persisted): `diamond_score`, `confidence`, prob fields (`hit_/total_base_/hr_/rbi_/run_/sb_/pitcher_win_/quality_start_probability`), `projected_outs`, `inputs` JSON (pitcher components, game environment, narrative), `environment_agreement`.
- **Drivers available without engine change**: `batting_order` (lineups), opposing pitcher (probable pitcher on `games`), park factor + run-environment rating (game env inputs), `lineup_status` (already surfaced).
- **Not yet computed/stored**: weather, recent-form (L14 wRC+), explicit bullpen adjustment number, platoon flag. These render as "—" placeholders so the UI is ready when data lands.

## 1. Shared building blocks

Create small presentational components under `src/components/diamond/`:

- `PrimaryMetricsRow.tsx` — Diamond Score · Mean Projection · Sim Probability · Confidence · Edge (Edge hidden when null).
- `SimDetails.tsx` — collapsible: "2,000 simulations" · Mean · Median (p50) · Std Dev · p90 (percentile) · placeholder slot for future distribution chart.
- `PredictionDrivers.tsx` — chip/list grid: Batting Order, Opposing Pitcher, Bullpen Adj, Park Factor, Platoon, Weather, Recent Form (L14 wRC+), Lineup Status. Missing values render dimmed "—".
- `WhyTheModelLikesThis.tsx` — emoji-prefixed bullet list assembled from the same data (📈 Diamond, 🎲 Mean, 💥 Prob, 🏟️ Park, 👊 Opp SP HR/9 or K/9, 📍 Batting #, 🌡️ Weather, 🔥 Recent Form). Bullets with missing inputs are skipped — never invented.
- `SimMethodologyTooltip.tsx` — info icon with the required copy: *"Mean Projection is the average result across 2,000 Monte Carlo simulations. Probability is calculated from how often a player exceeds the selected threshold across those same simulations."*

All three sections render in the order: **Expected Performance → Sim Probability → Confidence**.

## 2. Data plumbing (no math, just exposure)

`src/lib/projections.functions.ts` → extend `getDiamondScores` payload per player with the fields already available:

- From `projections.inputs.game_environment` + game row: `park_factor`, `run_environment_rating`, `opponent_pitcher` (name + handedness + season HR/9, K/9), `team_run_projection`.
- From `lineups`: `batting_order`, `lineup_status`.
- Pass-through `projected_outs`, `environment_agreement` for pitchers.

Add `getGameSimDistributions(gamePk)` server fn that runs (or caches) the same `simulateGame` already used by `matchups.$gamePk.tsx` and returns the per-player `BatterDist`/pitcher dist map. Used by player pages and (lazily, per-game) by Top Props/Diamond Scores when a row is expanded — so we never block the leaderboard on 2k-iter sims.

## 3. Page changes

- `**src/routes/diamond-scores.tsx**`: rebuild hitter & pitcher cards using the new components. Header shows Diamond Score + Mean Projection (top stat for the card's category) + Sim Prob; "Sim Details" and "Why the Model Likes This" expand inline. Adds methodology tooltip in the page header.
- `**src/routes/top-props.tsx**`: each leaderboard row reordered to `Mean Projection · Monte Carlo Prob · Diamond Score · Confidence · Edge`. Mean column pulled from the per-game sim cache (lazy). "Best of the Day" hero re-labelled to surface mean + prob together. Tooltip added.
- `**src/routes/players.$playerId.tsx**`: new top section with Primary Metrics, Sim Details (live `BatterDist`), Prediction Drivers grid, and the "Why the Model Likes This" card. Distribution chart slot added (empty placeholder for now).
- `**src/routes/matchups.$gamePk.tsx**`: unchanged math; relabel column headers to "Mean H / Mean HR / …" and add tooltip to clarify these are post-simulation means.

## 4. Copy + framing

- Site header tagline updated to "MLB Simulation & Projection Engine".
- Diamond Score badge gets a small "model output" subtitle so it no longer reads as a betting grade.
- Probabilities everywhere get `%` suffix + the shared tooltip; no isolated probability displays without a paired mean.

## 5. Out of scope (explicit)

- No new probability fields invented. Strikeouts section in Top Props stays gated on real K-probability presence.
- No engine, weight, or calibration changes.
- Weather/platoon/recent-form remain placeholder slots until upstream ingestion exists.

## Technical notes

- Sim caching: memoize `simulateGame` results per `gamePk` in a server-side LRU keyed by `(gamePk, lineupHash)` to keep Top Props responsive.
- All new components are presentational + typed against existing `DiamondHitterCard`/`DiamondPitcherCard` shapes extended with optional sim fields, so absent data degrades gracefully.
- Hydration fix bundled in: replace `toLocaleString(..., { dateStyle, timeStyle })` formatting in the index header with the existing `formatChicago` helper to stop the SSR/client mismatch shown in runtime errors.

Critical safety rule:  
Do not delete, replace, simplify, or rewrite the existing Diamond engine, simulation engine, scoring engine, or probability math. This is a UI/data-exposure refactor only. Existing model outputs must remain the source of truth.

If a requested sim distribution field is not already available to a page, render — or a placeholder instead of changing engine logic. Ask before adding new server functions.

&nbsp;