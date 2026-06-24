## What's happening

The "Missing Supabase environment variable(s)" message comes from `src/integrations/supabase/client.ts` when `import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` are missing from the bundle. Both keys ARE present in `.env` now (added at 13:07), but the preview console errors are stamped 13:05 — the bundle the browser is running was built BEFORE the env file existed, so `VITE_*` got inlined as `undefined`.

On top of that:

- `.gitignore` ignores `.env`, so on this Vite/TanStack stack the managed Supabase env is not version-controlled and any sandbox refresh without a fresh `.env` write reproduces this.
- The hydration mismatch (SSR "16 games" vs client "0 games") is a downstream symptom: SSR fetched the schedule fine, then the client bundle threw inside `site-header.tsx` → `supabase.auth.getUser()` because `VITE_SUPABASE_*` was undefined, the root error boundary swallowed it, and the suspense query re-rendered with the empty fallback.

## Plan

1. **Force a fresh rebuild of the preview bundle** so the now-present `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` are inlined. Restart the dev server (`code--restart_dev_server`) — no code change needed for this step.

2. **Remove `.env` from `.gitignore`** for this Vite/TanStack stack so the managed Supabase env survives sandbox refreshes (the keys in `.env` are the publishable + URL, safe to commit; service role stays in secrets, not `.env`).

3. **Verify with Playwright on a mobile viewport (402×717)**: load `/`, `/auth`, `/standings`, `/odds`. Confirm no "Missing Supabase" string, no "Rain delay" boundary, and the header renders sign-in/sign-out correctly.

4. **If step 3 still shows missing env**, harden `src/integrations/supabase/client.ts` to render a friendlier inline message instead of throwing through the root error boundary (so a future env hiccup doesn't take down every tab).

No schema, RLS, Diamond Engine, or feature-logic changes. Frontend/infra only.

## Out of scope

- Edits to `src/integrations/supabase/client.ts`, `client.server.ts`, `auth-middleware.ts`, `auth-attacher.ts`, `types.ts` (auto-generated — only step 4 would touch `client.ts` and only its error rendering, not the env reads).
- Any change to projections, sim engine, lineup pipeline, or admin routes.
