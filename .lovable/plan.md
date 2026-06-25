## Goal
Ship Diamond Design System 2.0 — a calm, light, "front-office software" visual refresh. Token-driven so most surface area shifts automatically, then targeted refinements on header, cards, tables, home, and player pages. Zero changes to routing, layout structure, engines, scoring, or probability math.

## Sequencing (verify each step before moving on)
1. Tokens (`src/styles.css`) + root shell (`__root.tsx`) — verify the whole app re-themes to light without broken contrast.
2. Site header refinement.
3. Shared primitives: `diamond-card` utility, `stat-pill` component, `table-modern` utility.
4. Route-specific polish: home hero/featured, player page dossier treatment.
5. Light additive sweep of tables (additive class only) + minor button/badge polish.

## 1. Design tokens — `src/styles.css`

**Theme switch**: convert from dark default to light default. Remove `className="dark"` from `<html>` in `__root.tsx`. Keep current dark token block re-homed under `.dark` so an optional dark mode can return later (no UI exposed now).

**Typography**: keep Inter (sans) and JetBrains Mono. Add Instrument Serif as the new `--font-display` via the `@fontsource/instrument-serif` package (matches existing `@fontsource/*` install pattern); if that package isn't available on the registry, fall back to the closest installed option (keep current Oswald) rather than introducing a new dependency mechanism.

**Display-font scope (per guardrails)**: serif is reserved for the DIAMOND wordmark, H1, H2, and major display moments. H3, table headers, filter labels, buttons, badges, mono numerics, and dense dashboard UI stay Inter / JetBrains Mono. Base layer:
```css
h1, h2, .display { font-family: var(--font-display); letter-spacing: -0.01em; }
h3, h4, h5, h6 { font-family: var(--font-sans); font-weight: 600; letter-spacing: 0; }
```

**Color tokens** (light theme, OKLCH equivalents of spec hexes):
```
--background: #F8FAFC  (warm off-white)
--foreground: #111827  (charcoal)
--card: #FFFFFF
--card-foreground: #111827
--popover: #FFFFFF
--popover-foreground: #111827
--primary: #2563EB     (Diamond Blue)
--primary-foreground: #FFFFFF
--secondary: #EEF2F7
--secondary-foreground: #111827
--muted: #F1F5F9
--muted-foreground: #475569
--accent: #EEF2F7
--accent-foreground: #111827
--destructive: #E11D48
--border: #E5E7EB
--input: #E5E7EB
--ring: #2563EB

/* Diamond extensions — keep names so existing code keeps compiling */
--edge: #2563EB           (was cyan; now brand blue)
--edge-foreground: #FFFFFF
--live: #E11D48
--chalk: #FFFFFF
--dirt: #B45309           (legacy alias, unused after refresh)
--grass: #059669

/* New semantic tokens */
--success: #059669
--warning: #D97706
--shadow-card: 0 1px 2px rgba(17,24,39,0.04), 0 4px 12px rgba(17,24,39,0.04);
--shadow-card-hover: 0 2px 4px rgba(17,24,39,0.06), 0 12px 28px rgba(17,24,39,0.08);
```
Register `--color-success` and `--color-warning` in the `@theme inline` block so `bg-success` / `text-warning` resolve.

**Preserve semantic status colors**: existing per-page tone classes (emerald success, amber warning, rose negative, live red, calibration buckets, admin debug panels, chart colors) stay as-is. The token swap intentionally only re-routes the global surface tokens; explicit `text-emerald-*`, `bg-amber-*`, etc. stay untouched.

**Body**: remove the dark "field-lighting vignette" `body::before` radial gradients (they only make sense on dark). No replacement gradient — clean off-white.

**Radius**: bump base `--radius` from `0.75rem` to `0.875rem` for a softer, "collectible" feel.

**Utilities (Tailwind v4 `@utility`)**:
- `card-elevated` — `background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-card); transition: box-shadow 200ms, transform 200ms;` with `&:hover { box-shadow: var(--shadow-card-hover); transform: translateY(-1px); }`.
- `table-modern` — additive class only; supplies sticky `thead` background, slate uppercase header text, subtle zebra (`tbody tr:nth-child(even) { background: color-mix(in oklab, var(--muted) 35%, transparent); }`), hover row tint, lighter row dividers. Does NOT set overflow, width, border-radius, or container behavior — those stay on the existing wrapper.

## 2. Root shell — `src/routes/__root.tsx`
- Drop `className="dark"` from `<html>`.
- Update title/description to "Diamond — MLB simulation & projection engine. Built for baseball."
- Footer copy unchanged; lighten color to slate.

## 3. Site header — `src/components/site-header.tsx`
Visual refinement only. Nav items, order, and routes unchanged.
- Logo: slim white card containing `◆` glyph in Diamond Blue, paired with serif "DIAMOND" wordmark in charcoal.
- Tagline restyled as muted slate small-caps (Inter).
- Header padding bumped to `py-4` desktop.
- Active nav: replace filled `bg-secondary` with a 2px bottom border in primary blue + charcoal text; idle items in slate. Idle hover: subtle slate tint.
- Mobile scroll-nav: same treatment.

## 4. Shared primitives (new, presentation-only)
- `src/components/ui/diamond-card.tsx` — wraps shadcn `Card` with `card-elevated` + size variants (`sm`, `md`, `lg`). Drop-in; existing `Card` keeps working everywhere it's used today.
- `src/components/ui/stat-pill.tsx` — small pill for Diamond Score / Confidence / Mean values, tonal variants (`neutral`, `positive`, `warning`, `negative`, `info`). Available for use; not retro-applied page-by-page in this pass (avoid the mass replace per guardrails). Used in featured cards and player dossier only.

## 5. Tables — additive only
Per guardrails, `table-modern` is **added alongside** existing wrappers. Pattern:
```tsx
// before
<div className="overflow-x-auto rounded-lg border border-border/60 bg-card/30">
  <table className="w-full text-left text-xs">
// after
<div className="overflow-x-auto rounded-lg border border-border/60 bg-card/30">
  <table className="table-modern w-full text-left text-xs">
```
The wrapper, `overflow-x-auto`, radius, and mobile horizontal scrolling are preserved exactly. Applied to: `odds.tsx`, `top-props.tsx`, `diamond-scores.tsx`, `slate.tsx`, `lineup-status.tsx`, `calibration-lab.tsx`, `leaderboards.tsx`, `standings.tsx`. No column, row, or structural changes.

## 6. Home page — `src/routes/index.tsx`
Refine only the hero + featured cards above today's slate. All sections below stay where they are.
- Hero: serif "DIAMOND" wordmark (large H1), one-line slate subtitle "MLB Simulation & Projection Engine," and a status line "Today's simulations are complete · {n} games."
- Three featured cards using `diamond-card`: **Top Simulation Leaders → /odds**, **Diamond Scores → /diamond-scores**, **Live Matchups → /scores**. Each: small-caps Inter eyebrow, serif H2 title, one-line Inter description, mono "Open →" affordance.
- Slate, simulation insights, model highlights, and calibration sections below: unchanged structure, just inherit the new tokens.

## 7. Player pages — `src/routes/players.$playerId.tsx`
Visual-only:
- Header as "scouting dossier": serif H1 player name, Inter slate caption (team · position · handedness), right-aligned trio of `stat-pill`s for Diamond Score / Confidence / Mean Sim.
- Section headings ("Why the Model Likes This," "Simulation Breakdown," "Prediction Drivers," "Recent Results," "Historical Calibration") become serif H2 with a thin underline accent and generous top margin.
- Existing panels swapped to `diamond-card` where they currently use ad-hoc dark backgrounds.

## 8. Misc polish (low-risk, no global sweeps)
- `src/components/ui/button.tsx` `default` variant: add `transition-all` + 1px hover lift via shadow. No API changes.
- `src/components/score-card.tsx`: swap solid background for `diamond-card`, lighten dividers. Live-game indicators (red dot, "LIVE" pill) preserved.
- Tiny inline-SVG icon set `src/components/icons/diamond-icons.tsx` (Simulation, Performance, Projection, Model, Diamond Score, Matchups, Conditions, Trends). Used only in featured cards and player-page section headings. No widespread icon retrofit.

## Out of scope (explicit)
- No routing or nav-item changes.
- No layout reflow; columns, grids, and breakpoints stay exactly as-is.
- No changes to data fetching, server functions, engines, calibration math, or any probability surface.
- No global find-and-replace of hardcoded color classes — semantic per-page tones (emerald/amber/rose, chart palettes, admin debug, live indicators) preserved.
- No dark-mode toggle UI in this pass.

## Verification (per step)
- After step 1: Playwright screenshot `/` desktop + mobile — confirm light background, serif H1, readable contrast, no broken dark surfaces.
- After step 2: header screenshot — logo serif wordmark, blue underline active nav.
- After step 3: render-only smoke (no visual yet).
- After step 5: screenshot `/odds` and `/diamond-scores` desktop AND 414px mobile — verify horizontal table scroll still works.
- After step 6/7: screenshots of `/` and `/players/<id>` desktop + mobile.
- Final: `tsgo` typecheck clean.
