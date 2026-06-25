## Goal
Add a **Top Props** view that surfaces the highest-probability player props from today's Diamond Engine projections, so you can scan the best bets at a glance.

## What you'll see
A new `/top-props` page (also linked from the site header) listing the strongest plays across today's slate:

- **Top Hitter Props**: Hit ≥1, Total Bases ≥2, HR ≥1, RBI ≥1, SB ≥1 — each ranked by probability.
- **Top Pitcher Props**: Win, Quality Start, Ks ≥ line — ranked by probability.
- **Filters**: prop type (All / Hit / TB / HR / RBI / SB / Pitcher), minimum probability slider (default 60%), team filter.
- **Sort**: probability desc (default), or Diamond Score desc.
- Each row: player name + team + matchup + lineup spot + probability bar + Diamond Score badge + lineup status (Official / Aggregated / Projected).
- Click row → existing player page.

## Default "Best of the Day" strip
Top of page shows 5 hero cards (one per prop type) with the single highest-probability play for each — e.g. "Safest Hit: Freeman 82%", "Top HR: Judge 47%".

## Data source
Pure read from existing `projections` table joined with `lineups`, `starting_pitchers`, `players`, `teams`, `games` — same shape as `getDiamondScores`. **No engine changes, no schema changes, no new writes.**

## Technical details
- **New server function** `getTopProps(date)` in `src/lib/projections.functions.ts`:
  - Reuses the `getDiamondScores` query, then flattens each projection into one row per prop type with `{ playerName, team, opponent, propType, line, probability, diamondScore, lineupStatus, mlbId, gamePk }`.
  - Returns sorted desc by probability; client filters/re-sorts.
- **New route** `src/routes/top-props.tsx`:
  - `useSuspenseQuery` with same retry/throwOnError hardening as `/diamond-scores`.
  - Hero strip computed client-side (max per prop type).
  - Table + filter controls using existing shadcn `Tabs`, `Slider`, `Select`, `Badge`, `Progress`.
- **Header link**: add "Top Props" to `src/components/site-header.tsx` between Diamond and Slate.
- **Empty state**: if no projections for today, show "Run today's pipeline" CTA linking to `/lineup-status`.

## Out of scope (ask if you want these next)
- Persisting prop "tickets" or parlays
- Sportsbook odds comparison / EV calculation
- Historical hit-rate tracking on top picks
