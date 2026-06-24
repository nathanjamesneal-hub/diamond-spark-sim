## What's happening

The "Rain delay" screen is the root error boundary in `src/routes/__root.tsx`. It renders whenever a page throws — on the server during SSR, or on the client during hydration/render. Your console log shows the actual signal: `Warning: Error in route match: __root__/` — the `/` route itself is exploding before the page can mount, which is why even refreshing or tapping "Go home" lands back on the same error screen. This isn't mobile-specific in the code; it's just that your phone is hitting cold SSR every time (desktop likely has a warm cached page or a session that masks it).

Two things make this hard to debug today:

1. The error boundary throws away `error.message` and only shows the friendly "Rain delay" copy, so there's no signal to the user or to us.
2. `/` runs a server loader (`getSchedule`) that hits MLB + Supabase. If that throws during SSR (rate-limit, RLS, env, network), the entire root route errors out — there's no per-route fallback shown because the root boundary catches it first.
3. `/auth` and other top-level routes are SSR by default. `/auth` only makes sense in the browser (it depends on `window`, Supabase session, the Lovable OAuth helper) — SSR'ing it is pure downside.

## Plan

### 1. Surface the real error (so we stop guessing)

In `src/routes/__root.tsx` `ErrorComponent`:
- Render `error.message` and `error.name` in a collapsible `<details>` block (kept subtle, not scary).
- Keep "Try again" / "Go home" buttons.
- Keep `reportLovableError(error, ...)` so it lands in runtime logs.

This alone will tell us on the next mobile load exactly what's blowing up.

### 2. Stop SSR'ing pages that don't need it

Add `ssr: false` to:
- `src/routes/auth.tsx` — depends on `window`, Supabase session, OAuth helper. Matches the pattern the integration already uses on `_authenticated/route.tsx`.
- `src/routes/lineup-status.tsx`, `src/routes/diamond-scores.tsx`, `src/routes/slate.tsx`, `src/routes/calibration.tsx`, `src/routes/leaderboards.tsx` — analytics dashboards backed by Supabase reads that should not block the document shell. They keep their loaders/queries; only the SSR pass is skipped.

The home `/` route stays SSR (it's the public landing), but we harden its loader (next step).

### 3. Harden the `/` loader so a flaky upstream doesn't nuke the page

In `src/routes/index.tsx`:
- Wrap the `scheduleQuery` so a failed fetch resolves to `{ date, games: [] }` instead of throwing. The page already handles "no games" gracefully.
- Keep `throwOnError` off for SSR; let the client re-fetch on hydration.
- Tighten the route's own `errorComponent` so even if it does throw, we see a useful message instead of bubbling to root.

### 4. Verify

- Read `stack_modern--server-function-logs` after the next reload to confirm what the original SSR error was (now visible via step 1 + the existing `error-capture` plumbing).
- Hit `/` and `/auth` from the preview on mobile viewport via Playwright; confirm no root error boundary and that `/auth` renders the sign-in form.
- Confirm desktop preview still works (regression check).
- Tap "Continue with Google" and "Sign in" once to confirm the OAuth helper still fires.

## Out of scope

- Diamond Engine formulas, Monte Carlo, cron, aggregation, projection persistence.
- RLS or schema changes.
- Visual redesign of the error boundary beyond adding the diagnostic `<details>` block.
- Changing the home page content or the lineup-status UI.

## Why these changes are safe

- `ssr: false` on auth/dashboard routes is the documented Lovable + TanStack pattern for browser-auth-dependent pages; the integration-managed `_authenticated/route.tsx` already uses it.
- The loader change on `/` swaps `throw` for an empty-slate fallback; the UI already renders an empty slate cleanly.
- The `ErrorComponent` change is additive — same buttons, plus diagnostics.
