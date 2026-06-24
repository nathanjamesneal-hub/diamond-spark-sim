## Plan: Connect Supabase via project secrets

Since the connector won't link to this project, we'll add your Supabase credentials directly as project secrets. The code already reads these env vars (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, plus `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` for the browser), so once the secrets are in place the app will start working — no code changes required.

### What you'll need from your Supabase project
From the Supabase dashboard → **Project Settings → API**:
1. **Project URL** — e.g. `https://xxxxx.supabase.co`
2. **Publishable (anon) key** — the public `anon` JWT
3. **Service role key** — the secret `service_role` JWT (server-only, never goes to the browser)
4. **Project ID** — the `xxxxx` ref from the URL

### Steps
1. I'll trigger a secure secrets prompt for these 6 names:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_PROJECT_ID`
   - `VITE_SUPABASE_URL` (same value as `SUPABASE_URL`)
   - `VITE_SUPABASE_PUBLISHABLE_KEY` (same value as `SUPABASE_PUBLISHABLE_KEY`)
2. You paste each value into the secure form.
3. I restart the dev server so Vite picks up the new `VITE_*` vars.
4. We verify by loading `/auth` and signing in.

### Important caveats
- **Migrations won't auto-run.** The connector normally applies the SQL files in `supabase/migrations/`. With manual secrets, you'll need to run those migrations yourself in the Supabase SQL editor (or via the Supabase CLI) before the app's queries will work. I can give you the consolidated SQL to paste in.
- **Google OAuth via Lovable broker won't work** without the connector. You'd need to either use email/password only, or configure Google OAuth directly in your Supabase dashboard (Authentication → Providers).
- **No auto-generated types refresh.** `src/integrations/supabase/types.ts` is frozen at its current state; if you change the schema later, you'll need to regenerate types manually.

Approve and I'll request the secrets, then walk you through running the migrations.