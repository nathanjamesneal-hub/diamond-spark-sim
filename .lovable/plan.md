## Plan: Provision Lovable Cloud (Supabase) for this project

Now that Lovable Cloud is enabled in your tool permissions, I can provision a fresh Supabase project and wire everything up.

### Steps
1. Call `supabase--enable` — this creates a new Supabase project, links it to this Lovable project, and auto-injects all six required env vars (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PROJECT_ID`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`).
2. Ensure `LOVABLE_API_KEY` exists (for AI gateway / connectors) via `ai_gateway--create`.
3. The existing migrations in `supabase/migrations/` will be applied automatically by the Cloud integration:
   - `20260622153924_*.sql` — initial schema
   - `20260622153942_*.sql` — follow-up schema
   - `20260623145521_*.sql` — additional tables
   - `20260624000000_diamond_engine_alpha_0_3.sql` — Diamond Engine alpha 0.3
4. Restart the dev server so Vite picks up the new `VITE_*` vars.
5. Verify by loading `/` and `/auth` — the 500 error should be gone and sign-in should work.

### What you'll get
- Working Postgres database with all your tables and RLS policies
- Auth (email/password + Google via Lovable broker)
- Server functions reaching Supabase with the bearer attached
- Service-role admin client available to ingest/sim functions

Approve and I'll run the provisioning.