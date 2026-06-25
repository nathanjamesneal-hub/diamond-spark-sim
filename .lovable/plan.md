## Goal

Pivot Diamond from the current light "front-office" refresh to a premium, electric **dark MLB broadcast** identity — Statcast credibility + Sunday Night Baseball polish + The Show energy. Token-driven so most of the app re-themes automatically, then targeted refinements on header, cards, tables, home, matchups, and player pages. Zero changes to routes, nav order, data fetching, engines, scoring, calibration, or probability math.

## Non-negotiables (carried from the brief)

- No route, nav, layout, engine, math, or data-fetch changes.
- No fabricated data, statuses, trends, or probabilities — only existing fields.
- Preserve every table wrapper, mobile horizontal scroll, filter, and responsive behavior.
- Restore dark as the default theme; do not ship a light/dark toggle in this pass.
- No sportsbook aesthetic, no neon-everywhere, no giant gradients, no flat black.
- Respect `prefers-reduced-motion` for every new animation.

## Sequencing (verify each step before moving on)

1. Tokens + fonts (`src/styles.css`) and root shell (`__root.tsx`) — flip default to dark, swap display font from Instrument Serif to Oswald, layered navy surfaces.
2. Shared visual primitives: team-color map, `card-elevated` restyle, `team-rail` utility, `stat-pill` tonal tweaks, `table-modern` dark restyle, `TeamSwatch` component.
3. Site header restyle (scorebug treatment).
4. Home hero + featured "three doors".
5. Cards: score cards, diamond/player cards, matchup cards — apply team rails and accent glows.
6. Tables sweep — visual only, additive class already in place.
7. Matchup + player pages — dossier treatment with team identity.
8. Hydration-safe polish (fix the `ScoreCard` SSR mismatch surfaced in runtime errors while we're in score-card.tsx).

## 1. Tokens, fonts, theme default — `src/styles.css` + `__root.tsx`

**Theme default**: re-add `className="dark"` on `<html>` in `src/routes/__root.tsx`. Keep `:root` as the dark token block; move the current light tokens under `.light` for optional future use (no UI toggle).

**Fonts**:

- Remove the Instrument Serif `@import` and stop referencing `--font-display: Instrument Serif`.
- Promote already-installed Oswald to `--font-display`. Keep Inter (sans) and JetBrains Mono (mono/stat).
- Base layer: `h1, h2, .display, .wordmark` use Oswald with `font-weight: 600`, `letter-spacing: 0.01em`, uppercase only for the wordmark and page eyebrows (not body H2). `h3–h6` stay Inter 600.

**Dark surface stack** (OKLCH approximations of the named hexes):

```
--background:        #0A0F1C   midnight navy / near-black blue
--surface-panel:     #0F1626   deep graphite-navy   (main panels)
--card:              #131C30   slightly brighter slate-navy (elevated)
--card-foreground:   #E6EAF2   off-white
--muted:             #182238
--muted-foreground:  #94A3B8   cool gray secondary
--border:            #1F2A44   subtle blue-gray
--input:             #1F2A44
--primary:           #2F7BFF   Diamond Blue (broadcast-bright)
--primary-glow:      #5BA0FF
--primary-foreground:#0A0F1C
--ring:              #2F7BFF
--success:           #10B981   emerald (strong outcomes)
--warning:           #F59E0B   amber (medium confidence)
--destructive:       #F43F5E   rose (misses / live-risk)
--live:              #F43F5E
--edge:              #2F7BFF   (alias, brand blue)
--edge-foreground:   #0A0F1C
--chalk:             #E6EAF2
--grass:             #10B981
```

**Shadows + glow** (controlled, not casino):

```
--shadow-card:        0 1px 0 rgba(255,255,255,0.03) inset,
                      0 8px 24px rgba(0,0,0,0.35);
--shadow-card-hover:  0 1px 0 rgba(255,255,255,0.05) inset,
                      0 12px 32px rgba(0,0,0,0.45),
                      0 0 0 1px color-mix(in oklab, var(--primary) 35%, transparent);
--glow-edge:          0 0 14px color-mix(in oklab, var(--primary) 55%, transparent);
--glow-live:          0 0 10px color-mix(in oklab, var(--live)    55%, transparent);
```

**Body texture**: a single `body::before` with two layered radial spotlights (4–6% opacity Diamond Blue) plus a 1px subtle grid mask (~3% opacity) to suggest scoreboard/field grid. Fixed, non-interactive, `pointer-events: none`. Disabled under `@media (prefers-reduced-motion: reduce)` (texture stays; only the sweep animation in §2 is suppressed).

**Radius**: keep `--radius: 0.875rem`. Cards stay soft; broadcast feel comes from contrast and accent rails, not pill shapes.

**Preserve** existing semantic class usage (`text-emerald-*`, `bg-amber-*`, `text-rose-*`, calibration bucket colors, admin debug panels, chart palettes) — token swap only re-routes global surface tokens.

## 2. Shared visual primitives

**Team colors** — new `src/lib/team-colors.ts`:

- `TEAM_COLORS: Record<string /* abbrev */, { primary: string; secondary: string }>` for all 30 MLB teams, primary/secondary picked to be dark-mode-legible (already-vivid official primaries with a paired contrast accent).
- Helpers `getTeamColor(abbrev)` (safe fallback to Diamond Blue) and `teamRailStyle(abbrev)` returning a `{ borderLeftColor }` style object.
- Exported as plain data; no runtime data fetching.

`**TeamSwatch` component** — `src/components/ui/team-swatch.tsx`:

- Tiny 8px rounded dot + abbreviation, optional `size: "xs" | "sm"`.
- Used inline beside every team abbreviation across leaderboards, score cards, and tables.

**Card utility** — extend `card-elevated` in `src/styles.css`:

- Background `--card`, 1px `--border`, `--shadow-card`. Hover: `--shadow-card-hover` + 1px translate. Focus-within ring uses `--primary`.
- New companion `@utility team-rail` for the 3px left accent rail consuming an inline `border-left-color`. Cards/rows opt in by adding `team-rail` and an inline `style={{ borderLeftColor: getTeamColor(abbr).primary }}`.

`**DiamondCard**` (`src/components/ui/diamond-card.tsx`):

- Keep the size variants. Replace the serif `DiamondCardTitle` with Oswald (font-display) but lowercase tracking-normal so it reads "scouting card" not "magazine."
- Add optional `teamAbbr?: string` prop that, when present, applies `team-rail` + inline border color.

**Stat pill** (`src/components/ui/stat-pill.tsx`):

- Re-tune tonal variants for dark: `neutral` (slate), `positive` (emerald 500/15% bg), `warning` (amber), `negative` (rose), `info` (Diamond Blue). Add `intense` variant with subtle outer glow for the single "hero" stat on a card (Diamond Score / Mean).

`**table-modern` restyle** — same selector, dark palette:

- `thead th`: sticky, `--surface-panel` background, uppercase Inter 600, 11px, `--muted-foreground`.
- `tbody tr:nth-child(even)`: `color-mix(in oklab, var(--muted) 40%, transparent)`.
- `tbody tr:hover`: `color-mix(in oklab, var(--primary) 8%, transparent)`.
- Optional row-level team rail: rows can add `data-team="PHI"` and a `[data-team]` selector reads a CSS custom property `--row-team-color` from inline style for the left border. (Falls back to no rail when omitted.)

**Scan/sweep utility** — `@utility sweep`:

- 1.5s linear gradient sweep (transparent → 8% Diamond Blue → transparent) used only on elements explicitly tagged "live" or "freshly updated." Wrapped in `@media (prefers-reduced-motion: reduce) { animation: none; }`.

## 3. Site header — `src/components/site-header.tsx`

Visual only. Nav items, order, and routes unchanged.

- Surface: `--surface-panel` with `border-b border-border` and a faint inset top highlight (1px white @ 4%).
- Logo: 36px rounded square, `--card` background, `◆` in Diamond Blue with `--glow-edge`.
- Wordmark: Oswald 700, uppercase, tracking `0.04em`, off-white.
- Tagline: Inter 500, 10px, uppercase, `0.22em` tracking, `--muted-foreground`. Copy: "MLB Simulation & Projection Engine."
- Active nav: bright `--foreground` + 2px Diamond Blue bottom border + subtle `--glow-edge` under the border.
- Idle nav: `--muted-foreground`, hover lifts to `--foreground` with a 1px underline animation (reduced-motion safe).
- Mobile scroll-nav: same treatment, retains horizontal scroll.
- Admin link stays Oswald uppercase mono-feel in Diamond Blue.
- Sign in/out buttons keep current shape; restyled for dark.

Optional micro live indicator: render a 6px live dot + "LIVE" pill **only** when the existing scores/slate data on the route already exposes a live game count (read from `useSuspenseQuery` already mounted on `/scores` or `/`). Do NOT invent a status or fetch new data; if the data isn't already in cache for the current route, render nothing.

## 4. Home — `src/routes/index.tsx`

Refine hero + featured cards above today's slate. Everything below (slate, simulation insights, model highlights, calibration sections) keeps its current structure and inherits new tokens.

Hero:

- Background uses the body texture plus one additional ultra-faint baseball-seam SVG (inline, ~3% opacity, pointer-events none).
- H1 "DIAMOND" — Oswald 700, uppercase, very large (clamp 56–96px), letter-spacing `0.02em`, off-white with a hairline Diamond Blue underline.
- Subtitle Inter 500, slate, "MLB Simulation & Projection Engine."
- Status line built from already-fetched slate query: `"Today's simulations are complete · {n} games on slate"` — render only when the query has resolved with `n > 0`. No new fetch.

Three "doors" via `DiamondCard size="lg"`:

- **Top Simulation Leaders → /odds** — Diamond Blue eyebrow, `intense` blue stat pill, mono "Open →".
- **Diamond Scores → /diamond-scores** — emerald + Diamond Blue accents.
- **Live Matchups → /scores** — dual rail: 3px left rail using two diagonal team colors of the first live game if cached (else neutral). Card adds `sweep` only when at least one live game exists in cache.

## 5. Cards

`**src/components/score-card.tsx**`:

- Wrap in `DiamondCard` with `teamAbbr` rail using the home team color; right edge has a 3px rail in the away team color for the dual-team treatment.
- Add `TeamSwatch` beside both team abbreviations.
- Preserve live indicators (red dot, LIVE pill); restyle with `--glow-live`.
- Inning / score typography promoted to JetBrains Mono tabular for clarity.
- Fix the hydration mismatch flagged in runtime errors (away score swap "2 vs 1"): the in-progress score is read from a value that differs between server render and client. Resolution: render the score only client-side using a `useIsMounted` gate (or `suppressHydrationWarning` scoped to that single span) so SSR emits a stable placeholder ("—") and the client hydrates the live value. No data fetch changes; only render gating.

`**src/routes/diamond-scores.tsx` cards**:

- Each player card becomes a `DiamondCard` with team rail; primary stat (Diamond Score) uses `stat-pill` `intense`; secondary stats use tonal pills.
- Preserve sort/filter/tier badges exactly.

**Player route featured panels**: swap the ad-hoc dark boxes to `DiamondCard`, with team rail.

## 6. Tables

The `table-modern` class is already applied site-wide in the prior pass. This step is **visual restyling only** of that utility (done in §2) plus two additive tweaks:

- For leaderboards in `odds.tsx`, `top-props.tsx`, `diamond-scores.tsx`: add a `data-team={row.teamAbbr}` attribute on each `<tr>` and a small `<TeamSwatch>` inside the existing team cell. No column changes, no structural changes.
- For `/odds` Top 25 boards, increase rank-number visual weight via a `.rank-strong` utility (Oswald 600, slightly larger) without changing column layout.

No changes to `slate.tsx`, `lineup-status.tsx`, `calibration-lab.tsx`, `leaderboards.tsx`, or `standings.tsx` beyond inheriting the new table look.

## 7. Matchups + player pages

`**src/routes/matchups.$gamePk.tsx**`:

- Header gets a two-tone treatment: a thin horizontal gradient header bar split at center, away team color (8% opacity) on the left, home team color (8% opacity) on the right, neutral `--card` center for game time and model status.
- Add `TeamSwatch` next to each team name. Section headers (Mean H, Mean HR, etc.) stay Inter — these are dense stat blocks, not display.
- Preserve all projection tables and existing copy.

`**src/routes/players.$playerId.tsx**`:

- Header: Oswald H1 player name, Inter slate caption (team · pos · handedness), team rail on the header card, right-aligned trio of `stat-pill intense` for Diamond Score / Confidence / Mean Sim.
- Section headers ("Why the Model Likes This," "Simulation Breakdown," "Prediction Drivers," "Recent Results," "Historical Calibration") become Oswald H2 with a 2px Diamond Blue underline accent (24px wide).
- "Why the Model Likes This" gets a featured surface — `DiamondCard` with a faint Diamond Blue inner glow (1px ring at 25%).

## 8. Misc polish

- `src/components/ui/button.tsx` `default` variant: dark-tuned, subtle Diamond Blue background hover and `--glow-edge` on focus-visible. No API changes.
- `src/components/diamond/*` (PrimaryMetricsRow, SimDetails, PredictionDrivers, etc.): swap any leftover light-mode backgrounds for `--card` / `--surface-panel`; ensure mono numerics use `var(--font-mono)`.
- Site footer: keep copy; color it `--muted-foreground`.

## Out of scope (explicit)

- No new routes, nav items, or layout reflow.
- No engine, scoring, simulation, calibration, or probability changes.
- No new data fetches; status/live indicators only render off data already loaded by existing queries.
- No global find-and-replace of semantic per-page tones (emerald/amber/rose, chart palettes, admin debug, live indicators).
- No light/dark toggle UI; dark is the only theme exposed.

## Verification (per step)

- After step 1: Playwright screenshot `/`, `/odds`, `/diamond-scores` at 1280×1800 and 414×900 — confirm dark surfaces, Oswald display, no broken contrast, no leftover Instrument Serif, body texture readable.
- After step 3: header screenshot — wordmark Oswald, glowing diamond, blue underline active nav, mobile scroll-nav intact.
- After step 5: screenshot `/scores` desktop + 414px — confirm dual-team rail on score cards, live indicator glow, hydration error resolved (no React warning in console).
- After step 6: screenshot `/odds` and `/diamond-scores` — verify horizontal table scroll still works on 414px, team swatches present, sort/filter unchanged.
- After step 7: screenshots of a matchup and a player page desktop + mobile.
- Final: `tsgo` typecheck clean; reduced-motion media query confirmed via DevTools emulation; runtime-errors panel empty for the ScoreCard hydration trace.

Implementation hardening:

- Normalize team abbreviations before applying `TEAM_COLORS` so aliases such as `AZ/ARI`, `ATH/OAK`, `CWS/CHW`, `KC/KCR`, `SF/SFG`, and `TB/TBR` resolve correctly. Unknown or missing teams must safely fall back to Diamond Blue.
- Team-color accents must meet contrast/readability requirements on dark surfaces. Use the color only for rails, swatches, low-opacity washes, and small highlights—not text unless contrast is verified.
- Keep all existing table containers, `overflow-x-auto`, filters, sorting, row click targets, and mobile breakpoints intact. Team swatches and rails are additive only.
- For the ScoreCard hydration fix, render a stable SSR placeholder for only the volatile live-score span, then reveal the client value after mount. Do not gate the entire score card or change score-fetching behavior.
- Do not add external logo/image dependencies or scrape team assets in this pass. Team identity should come entirely from the local color map and existing app assets.
- Build this in the specified sequence and verify each stage before continuing. If a styling change causes a type error, hydration warning, contrast failure, or mobile overflow regression, stop and fix that issue before proceeding.