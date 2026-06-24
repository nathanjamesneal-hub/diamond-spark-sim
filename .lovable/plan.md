# Diamond Scores — Display-Only Section

A new read-only page that surfaces stored Diamond Engine outputs as Hitter and Pitcher cards. **No model, engine, registry, sim, ingestion, or schema changes.** Reads existing `projections` rows joined with `lineups`, `starting_pitchers`, `players`, `teams`, and `games`.

## 1. New server function — `src/lib/projections.functions.ts`

Add `getDiamondScores({ date? })` alongside the existing `getTodaysSlate`. Returns:

```ts
{
  date: string;
  modelVersions: string[];    // distinct versions present today (for filter)
  activeVersion: string | null;
  games: { id: string; label: string }[];   // for game filter
  teams: { id: string; abbrev: string }[];  // for team filter
  hitters: HitterCard[];
  pitchers: PitcherCard[];
}
```

For each game on `date`:
- Load `lineups` (hitters) and `starting_pitchers` (pitchers).
- Load latest `projections` row per `(player_id, game_id, model_version)` — keep ALL model versions (not just active) so users can filter.
- Join player names, team/opponent abbreviations, game status, first pitch.

Split rows by `projection_role` (`'hitter'` / `'pitcher'`). When `projection_role` is null, infer from whether the player came from `lineups` vs `starting_pitchers`.

### Field mapping (existing columns → card fields)

**Hitter card** (from `projections`):
- diamond_score, contact_score, power_score, speed_score
- pitcher_grade, matchup_grade
- confidence
- hit_probability, total_base_probability, hr_probability, rbi_probability, run_probability, sb_probability
- model_version
- batting_order from `lineups`
- Plus: player name, team abbrev, opp abbrev, game status, first_pitch_at
- `inputs` jsonb → used to render the "why" explanation (top 2–3 weighted factors if present; otherwise show contact/power/speed/pitcher-grade summary)

**Hitter fields NOT in schema** → show "Not available yet" with a small "field: …" note:
- Hit over 0.5 probability
- Hit over 1.5 probability
- Total bases projection (numeric — only `total_base_probability` exists)
- TB over 0.5 / 1.5 / 2.5 probability

**Pitcher card** (from `projections`):
- diamond_score (as "Diamond Pitcher Score")
- projected_outs, quality_start_probability, pitcher_win_probability
- confidence, model_version
- Plus: pitcher name, team, opponent, game status, `inputs` for the "why"

**Pitcher fields NOT in schema** → "Not available yet":
- Strikeout projection
- K over 3.5 / 4.5 / 5.5 / 6.5 probability
- Earned runs projection
- ER under 2.5 probability
- Hits allowed projection
- Walks projection

These are documented inline on the card (greyed "Not available yet — field `k_projection` not stored") and listed once in a collapsible "Missing fields" footer on the page.

This function uses the existing `publicClient()` helper (no auth required, public Data API with anon SELECT on these tables — same pattern as `getTodaysSlate`). No new RLS/grants.

## 2. New route — `src/routes/diamond-scores.tsx`

```text
/diamond-scores?date=YYYY-MM-DD&tab=hitters|pitchers&sort=...&game=...&team=...&version=...
```

- `validateSearch` with `zodValidator` + `fallback` (per `tanstack-search-params`).
- Loader primes Query cache via `ensureQueryData`; component uses `useSuspenseQuery` (per `tanstack-query-integration`).
- `errorComponent` + `notFoundComponent` defined.
- `head()` with route-specific title/description/OG.

### Layout

- Header: date stepper (Prev / Today / Next, reusing the same shiftIsoDate util as `/scores`) + active model version chip.
- Filter bar (mobile: stacks; sm+: inline): Game select, Team select, Model version select.
- Sort select:
  - Hitters: Diamond Score (default), Hit %, HR %, RBI %, SB %.
  - Pitchers: Diamond Pitcher Score (default), K projection (disabled with tooltip "Not available yet" until field exists).
- Tabs (shadcn `Tabs`): "Hitter Cards" / "Pitcher Cards". Tab state is in search params.
- Card grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`.

### Card design (mobile-first)

Each card:
- Header row: player name (links to `/players/$playerId` if id exists) · team `vs` opp · status pill (Live / Final / Locked / Confirmed / Waiting).
- Tier badge (top-right): 95+ ELITE (primary), 90–94 A, 85–89 B, 80–84 C, <80 PASS — derived from `diamond_score`; uses existing tokens (`bg-primary/15 text-primary`, `bg-edge/15 text-edge`, `bg-secondary text-muted-foreground`).
- Big "Diamond Score" number + Confidence sub-line + model_version mono chip.
- Sub-scores row (hitters): Contact / Power / Speed / Pitcher Grade / Matchup Grade.
- Probability grid: 2-col on mobile, 3-col sm+. Each cell `label / value%`. Missing fields render `Not available yet` in muted style.
- "Why this score" — one short sentence built from existing fields only:
  - Hitters: highlight top sub-score(s) above league avg (contact ≥ X, power ≥ Y…) and matchup_grade direction. If `inputs` jsonb has a `components`/`weights`/`narrative` field, prefer that.
  - Pitchers: combine quality_start_probability, projected_outs, win_probability.
- Footer: Link to `/matchups/$gamePk` if gamePk available.

### Sort/filter implementation

- All controls write to search params via `useNavigate({ from: Route.fullPath })` using the function form `(prev) => ({ ...prev, ... })` (per `tanstack-search-params`).
- Sorting and filtering happen in the component over the loader payload (small N per day).
- Default sort: Diamond Score desc, nulls last.

## 3. Navigation — `src/components/site-header.tsx`

Insert "Diamond" link between "Projections" and "Calibration":
`Today · Scores · Odds · Standings · Projections · Diamond · Calibration · Leaders · Admin (if admin)`

`to="/diamond-scores"`. No other nav changes.

## 4. Tier helper — co-located in the route file

```ts
function tier(score: number | null): { label: string; cls: string } { ... }
//  >=95 ELITE / 90-94 A / 85-89 B / 80-84 C / <80 PASS / null → "—"
```

## 5. Non-goals (explicitly preserved)

- `src/lib/engines/v0_1_0/engine.ts`, `src/lib/engines/alpha_0_3/engine.ts`, `src/lib/engines/registry.ts` — untouched.
- `src/lib/sim/*`, `src/lib/sim.functions.ts` — untouched.
- `src/lib/ingest.functions.ts` — untouched (Import Schedule / Pitchers / Lineups / Run Diamond Engine flow stays as-is).
- `src/routes/slate.tsx`, `src/routes/calibration.tsx`, `src/routes/_authenticated/_admin/admin.tsx` — untouched.
- Supabase schema, RLS, grants, projection rows — untouched. No migration.
- No client-side recomputation of Diamond Engine outputs.

## 6. Verification after build

1. `bunx tsgo --noEmit` — passes.
2. Visit `/diamond-scores`: both tabs render; sort/filter update URL; tier badges show; missing fields say "Not available yet".
3. Visit `/slate`, `/calibration`, `/admin` — unchanged behaviour.
4. Confirm `registry.ts` still exports both `v0_1_0` and `alpha_0_3` (no diff).

## Open question (only if you want to adjust)

The schema has **no** numeric columns for: Hit over 0.5/1.5, TB projection + TB overs, K projection + K overs, ER projection + ER under 2.5, hits allowed, walks. The plan shows them as "Not available yet" rather than computing them client-side. If you'd like, the Diamond Engine can be extended in a separate, explicit task to persist these (would require a migration + engine output change — both excluded here per your "do not change formulas / do not change schema unless explicitly requested" rules).
