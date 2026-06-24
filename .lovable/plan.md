## Problem

The sign-in screen throws "Missing Supabase environment variable(s)" because the project's `.env` file is gone from the sandbox. Last session I removed `.env` from `.gitignore` so it would survive, but the file itself was never committed — so when the sandbox refreshed, the managed `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` disappeared with it, and the client bundle has nothing to read.

The `/auth` route is `ssr: false`, so it relies entirely on the browser-side `import.meta.env.VITE_*` values that Vite inlines at build time. With no `.env`, those are `undefined` and `src/integrations/supabase/client.ts` throws on first access.

## Fix

1. **Recreate `.env`** at the project root with the known managed Lovable Cloud values (URL + publishable anon key + project id). These are publishable, safe to commit, and `.env` is already out of `.gitignore` from last session — so this time it will persist across sandbox refreshes.

2. **Restart the dev server** so Vite re-inlines the env into the client bundle.

3. **Harden `src/integrations/supabase/client.ts`** so a future missing-env situation renders a friendly inline message in the header/auth page instead of throwing through the root error boundary and nuking every tab. (Return a stub client whose first call surfaces a clear "Backend not connected" message, rather than `throw new Error` at proxy access.)

4. **Verify on mobile viewport (402×717)** with Playwright: load `/`, `/auth`, click "Sign in" elements, confirm no "Missing Supabase" string anywhere and no Rain Delay boundary.

## Out of scope

No schema changes, no auth provider changes, no feature-logic edits. Frontend + env only.