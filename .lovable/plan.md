
# Home Dashboard + Nav Cleanup

## Scope

Two presentation-only edits. No engine, registry, sim, schema, or data-fetching logic touched.

## 1. Home page (`src/routes/index.tsx`)

Keep the existing live scoreboard (featured matchup + all-games grid + EmptyState) intact. Replace the placeholder `ComingSoonStrip` at the bottom with a real **navigation dashboard**: four cards, mobile-first grid (1 col → 2 col @ sm → 4 col @ lg), each linking to its section.

Cards:

| Card | Link | Short copy |
|---|---|---|
| Live Scores | `/scores` | Live status, score, inning, and game state from MLB. |
| Odds | `/odds` | Sportsbook odds across DraftKings, FanDuel, MGM, and more. |
| Standings | `/standings` | AL & NL division standings, run diff, streaks, L10. |
| Diamond Projections | `/slate` | Diamond Score, hit/TB/HR/RBI/SB/run %, confidence, model version. |

Each card uses `<Link to=...>`, has a kicker label, title, one-line description, and a small "Open →" affordance. Uses existing tokens (`border-border/70`, `bg-card`, `font-display`, `mono`, `text-primary`/`text-edge`). No new icons library — keep it text-driven to match the current aesthetic.

The four cards render above the existing all-games grid so the homepage opens as a true dashboard. `ComingSoonStrip` is removed.

## 2. Header nav (`src/components/site-header.tsx`)

Current order: Today, Slate, Scores, Odds, Standings, Calibration, Leaders + Admin (conditional).

Reorder/relabel to match the requested set:

`Today · Scores · Odds · Standings · Projections · Calibration · Leaders · Admin (if admin)`

- "Projections" links to `/slate` (Slate route is the projections view).
- Leaders stays (already there; not in the request but removing it would regress navigation).
- Admin stays conditional on `has_role('admin')` — unchanged logic.

Mobile bar inherits the same array (already does).

## 3. Verification

- `bun run typecheck` (or `tsgo` per repo convention) after the two edits.
- Visual: load `/` and confirm the four dashboard cards render and link correctly; confirm header shows the new order and Admin link still gates on role.

## Non-goals

- No changes to `src/routes/scores.tsx`, `odds.tsx`, `standings.tsx`, `slate.tsx`, `calibration.tsx`, or their query functions.
- No engine, registry, sim, or Supabase schema changes.
- No new dependencies.

Confirm and I'll ship.
