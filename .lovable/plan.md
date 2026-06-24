
# Display-Only UI Layers — Model Stays Untouched

## Guardrails (non-negotiable)

These files/areas are **read-only** for this work. No edits, no refactors, no "tiny cleanups":

- `src/lib/engines/v0_1_0/engine.ts` — Diamond Engine v0.1.0
- `src/lib/engines/alpha_0_3/engine.ts` — Alpha 0.3 formulas
- `src/lib/engines/registry.ts` — model registry behavior
- `src/lib/sim/**` — Monte Carlo simulation logic
- `src/lib/game-environment.ts`
- Supabase tables: `projections`, `projection_results`, `calibration_summary`, `model_versions`, `player_dna`, `lineups` — no schema changes, no migrations
- `model_versions` rows — `alpha-0.3` stays inactive; `0.1.0` stays active
- No backfills, no recomputes, no upserts that would overwrite historical projection rows

If implementing a section reveals a missing column or missing data, I stop and ask before touching schema or the engine.

## What gets built (display layers only)

Each route is a pure read view that fetches via existing server functions / Supabase reads and renders. No projection math in components, no writes outside what existing ingest jobs already do.

1. **Live Scores** (`/scores`)
   - Source: MLB Stats API via the existing `src/lib/mlb.functions.ts` reader (or a new read-only server fn that wraps the same endpoint if one doesn't exist yet).
   - Shows today's slate: matchup, score, inning/state, probable pitchers. Auto-refresh on a polling interval while the page is open.
   - No writes to `games` or `starting_pitchers` from this page.

2. **Odds** (`/odds`)
   - Source: existing `src/lib/odds.functions.ts` integration. Render whatever it already returns (moneyline / total / spread per game).
   - No new odds provider, no new secrets.

3. **Standings** (`/standings`)
   - Source: existing standings reader (MLB API via `mlb.functions.ts`). Render division tables.

4. **Diamond Projections** (`/slate`, `/players/$playerId`, `/matchups/$gamePk`)
   - Source: `projections` table via existing `src/lib/projections.functions.ts`. Read only.
   - Filter by the currently active `model_versions` row (today: `0.1.0`). Show `diamond_score`, per-stat probabilities, confidence, and Alpha-only fields **only** when the row's `model_version = 'alpha-0.3'` (so historical Alpha rows still render correctly if they exist).
   - No recomputation in the component. The number on screen is exactly the number in the row.

5. **Calibration** (`/calibration`)
   - Source: `calibration_summary` table, read only. Group by `model_version` / `stat` / `confidence_bucket`. Render observed vs predicted.

## Routes touched

All under `src/routes/` — presentation only:

- `scores.tsx`, `odds.tsx`, `standings.tsx`, `calibration.tsx`, `slate.tsx`, `players.$playerId.tsx`, `matchups.$gamePk.tsx`

Most already exist. This pass wires them to the existing read functions and polishes layout — it does not introduce new server fns that compute projections.

## Data-fetching pattern

- Public routes (`scores`, `odds`, `standings`) → public server fn using the server publishable client + `TO anon` SELECT policies that already exist. Loader primes with `ensureQueryData`, component reads via `useSuspenseQuery`.
- Authenticated routes already under `_authenticated/` keep using `requireSupabaseAuth` reads.
- No loader calls a protected server fn from a public route.

## Explicit non-goals this pass

- No new migrations.
- No edits to engine, registry, or sim files.
- No flipping `alpha-0.3` to active.
- No ingest job changes (no new writes to `projections`, no recompute).
- No new third-party integrations or secrets.

## Checkpoints

After each section I'll confirm: (a) no files under the guardrail list changed, (b) numbers displayed match a direct `select` against the source table, (c) typecheck passes.

Confirm and I'll start with Live Scores, then Odds, Standings, Diamond Projections, Calibration.
