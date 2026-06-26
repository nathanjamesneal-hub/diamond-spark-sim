# Unify Diamond Score, Sim Mean, Probability + Add Diamond Consensus Board

Two deliverables, both display-only. No engine, simulation, Diamond Score, probability, snapshot, or calibration math will change.

---

## Part 1 — Data-Flow Audit (written into the chat reply, not a new file)

I'll trace each value end-to-end and post the audit in the response after you approve this plan. Audit will cover:

**Where each value is produced**

- `player_dna` (rolling rates, power tier, contact, plate discipline) → input to engine
- Matchup, pitcher/bullpen context, park, opportunity (batting order), lineup status → input to engine
- Engine (`src/lib/engines/alpha_0_3/engine.ts`) → produces per-player `diamond_score`, `confidence`, and per-category Monte Carlo `mean` + `probability` + `p50`/`p90`/`stdev`
- All persisted to `projections` table (single row per player+game+role+category-set)
- Snapshot copy → `sim_snapshot` JSONB (immutable pregame copy)

**Where each value is displayed**

- `/diamond-scores` — diamond_score + confidence
- `/odds` (Sim Leaders) — sim mean + probability, with diamond_score shown alongside
- `/top-props` — probability-led rankings
- `/slate`, `/matchups/$gamePk`, `/players/$id` — mixed
- `primary-metrics-row.tsx`, `why-model-likes-this.tsx` — labels

**Overlap / conflict points I expect to flag**

- `diamond-scores.tsx` and parts of `slate.tsx` label probabilities or DS as "Diamond Projection," which collides conceptually with Sim Mean.
- `primary-metrics-row` currently leads with Mean Projection but secondary cards re-show DS in a way that reads as a competing expected value.
- `why-model-likes-this` mixes input-side drivers (DNA/matchup) with output-side numbers without separating conviction vs expectation.

**Recommendation (smallest safe refactor)**

- Standardize three labels everywhere: **Sim Mean** (expected outcome) · **Sim Probability** (threshold/event likelihood) · **Diamond Score / Confidence** (conviction & input agreement).
- Fix label-only changes in: `primary-metrics-row.tsx`, `why-model-likes-this.tsx`, `diamond-scores.tsx`, `slate.tsx`, `top-props.tsx`, `odds.tsx`, `players.$playerId.tsx`. No data path changes.
- Add a small display-only `agreementClass(meanPct, probPct, dsPct)` helper in `src/lib/consensus.ts` returning `Strong Alignment | Simulation-Led | Diamond-Led | Low Alignment`. Used in tooltips/badges only.
- Will include 10 real-player example rows pulled from today's slate in the audit reply.

---

## Part 2 — Diamond Consensus Board (display-only)

### New files

- `src/lib/consensus.ts` — pure functions:
  - `categoryPercentile(values, value)` — rank-based percentile within a category+slate.
  - `consensusScore({ dsPct, meanPct, probPct, confidenceFactor })` — weighted 40/30/20/10; if `probPct` is null, redistribute the 20% proportionally to DS (8/12 → +13.3% to DS, +6.7% to Mean) — equivalent to 53.3/36.7/0/10.
  - `alignmentLabel(...)` — Full / Strong / Simulation-Led / Diamond-Led / Needs Context.
  - `lineupFactor(status)` — confirmed=1.0, projected=0.7, waiting=0.5, missing=0.3.
- `src/lib/consensus.functions.ts` — `getDiamondConsensus({ date, category?, team?, lineupStatus?, scope: "top25"|"all" })` server fn (member-gated). Reads existing `getSimulationLeaders` data per category for the date (no new queries against engine internals), computes percentiles within each category+slate, dedupes on `gamePk + mlbId + category + role`, returns rows with sim_mean, sim_probability, diamond_score, confidence, consensusScore, alignment, why-rank breakdown.
- `src/routes/_authenticated/diamond-consensus.tsx` — new route. Header "Diamond Consensus" / subtitle "Where Diamond Score, simulation output, and confidence align." Filters: Category, Team, Lineup Status, Top 25 / All Qualified. Default sort: consensusScore desc. Columns: Rank · Player · Team · Opp · Category · Sim Mean · Sim Probability · Diamond Score · Confidence · Consensus · Alignment. Row expander → "Why ranked" drawer with percentile breakdown.

### Nav

- Add link in the authenticated nav next to Sim Leaders / Top Props.

### Categories included

Hits, HR, RBI, Runs, Total Bases, SB, Pitcher Ks, Pitcher Outs, Win, QS. Percentiles computed strictly within category for the chosen date.

### Safety guarantees

- Pulls only from existing projection rows for the active model version (already filtered server-side, dedupe key matches Sim Leaders fix).
- No write-back of consensusScore to `projections` or `sim_snapshot`.
- No probability synthesis: missing prob → reweight, never invent.
- No sportsbook wording ("best bet" etc.).
- Sim Leaders, Top Props, Diamond Scores, calibration outputs untouched.

**Required Consensus Board refinements**

**Correct source-of-truth wording**

Keep Diamond Score and Monte Carlo outputs explicitly separate in the data-flow audit:

- Diamond engine / Alpha 0.3 produces Diamond Score, confidence, and input-side model context.
- Monte Carlo simulation produces Sim Mean, Sim Probability, p50/p90/stdev, and stat distributions.
- The Consensus Board combines existing outputs for display only.

Do not describe Alpha 0.3 as directly producing Monte Carlo means/probabilities unless the audit confirms that exact code path.

**Add a Balanced consensus view**

Keep the default Top 25 Overall Consensus ranking, but add a second scope/view:

- **Top 25 Overall** — highest consensus scores regardless of category.
- **Balanced Board** — show the strongest 3–5 qualifying signals from each available category, then sort those selected rows by consensus score.

Reason:  
Percentiles make categories comparable, but an overall Top 25 can still become visually dominated by categories with more eligible players or more available probability fields.

**Confidence integrity**

Use confidence only as a modest ranking modifier.

- Confirm the stored confidence scale and meaning before converting it to a factor.
- Do not treat confidence as an independently calibrated probability.
- Lineup status should act as an eligibility/reliability modifier only.
- A player should not leapfrog materially stronger simulation outputs solely because of confirmed-lineup status.

**Consensus transparency**

For every Consensus Score, show the exact component contribution:

- Diamond Score percentile
- Sim Mean percentile
- Sim Probability percentile or not available
- Confidence contribution
- Lineup-status contribution
- Final weighted score

Label the score:  
Consensus Rank — display-only agreement signal

Do not call it a new model projection, probability, Diamond Score replacement, or prediction grade.

---

## Out of scope (explicitly)

- Engine math, Monte Carlo, Diamond Score formula, probability math, snapshots, calibration grading, pitcher-outs fix.

## Verification after build

- Spot-check 5 players in audit table vs `/odds`, `/diamond-scores`, and new `/diamond-consensus` to confirm same underlying values.
- Confirm percentiles are within-category (no cross-stat comparison).
- Confirm dedupe key removes duplicate roles.