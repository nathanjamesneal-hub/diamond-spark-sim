## What's broken

Two separate issues, both blocking sign-in:

1. **"Missing Supabase environment variable(s)"** — the client bundle can't read `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`. The `.env` file approach we tried last session does not survive sandbox rebuilds in this project, so every fresh build, the keys are `undefined` and the Supabase client throws on first access (header avatar check, sign-in click, everything).

2. **"provider 'google' is not supported"** — Google OAuth is not enabled on the backend Auth config. The Lovable broker can issue the request, but Supabase Auth rejects it because the Google provider was never turned on for this project.

## Fix plan

### Step 1 — Enable Google as an auth provider (backend)
Call the social-auth configuration tool to enable `google` on Lovable Cloud Auth. This is what makes "provider 'google' is not supported" go away. Email/password stays enabled (you're already using it).

### Step 2 — Restore the client-side Supabase env so the bundle stops throwing
Recreate `.env` at the project root with the managed Lovable Cloud values:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SUPABASE_PROJECT_ID`

These are publishable values, safe to keep in the repo. Confirm `.env` is not in `.gitignore` so it persists. Restart the dev server so Vite re-inlines them into the client bundle.

### Step 3 — Harden the client so a future missing-env never nukes the whole app again
Change `src/integrations/supabase/client.ts` so that when the env vars are missing, it logs a clear console warning and returns a stub whose methods reject with a friendly "Backend not connected" message — instead of throwing at *proxy access time*, which is what's currently routing every page (header, auth, scores, odds…) into the Rain Delay boundary.

### Step 4 — Verify on your mobile viewport (402×717)
Playwright script that:
- loads `/` — confirms no Rain Delay, header renders
- loads `/auth` — confirms no "Missing Supabase" string
- clicks "Continue with Google" — confirms the broker actually starts the OAuth handshake (no "provider not supported")
- submits email/password with your account — confirms the email path also works

## Out of scope
No schema, RLS, Diamond engine, projections, odds, or feature-logic changes. This is purely auth wiring + frontend resilience.

## Technical note (for reference)
The "provider not supported" string comes from `gotrue` on the Auth server, not from the client. That confirms the request reaches the backend correctly — the backend just doesn't have Google turned on. So Step 1 is a true backend config change, not a frontend tweak.
