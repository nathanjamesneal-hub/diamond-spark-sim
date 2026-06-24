## Plan: Finish Lovable Cloud provisioning and validate the app

Lovable Cloud is provisioned and partially seeded. The first migration succeeded on the database side (the `handle_new_user`, `touch_updated_at`, and `has_role` functions are live, and Supabase URL/keys are injected), but the tool call was cancelled before all tables were created and before `src/integrations/supabase/types.ts` was regenerated — that's why the build still shows `"bets"` / `"teams"` / `"games"` as `never`.

### Steps

1. **Verify existing schema** via `supabase--read_query` against `information_schema.tables` so I apply only what's missing (avoid duplicate-object errors).
2. **Run a single migration** containing everything not yet applied:
   - Any missing tables from the original schema (profiles, bets, favorites)
   - User roles + `has_role` (idempotent guards)
   - Reference tables: `teams`, `players`, `games`, `starting_pitchers`, `lineups`, `player_dna`
   - `model_versions` (seed `0.1.0` active, `alpha-0.3` inactive)
   - `projections` (with Alpha 0.3 columns: `run_probability`, `pitcher_win_probability`, `quality_start_probability`, `projected_outs`, `environment_agreement`, `projection_role`, `game_environment`)
   - `projection_results` (with `runs`), `calibration_summary`
   - All RLS policies, GRANTs, indexes, and `touch_updated_at` triggers
3. **Auto-regen `src/integrations/supabase/types.ts`** — happens after the migration approval, fixing the entire wall of TS errors in `bets.functions.ts`, `ingest.functions.ts`, and `site-header.tsx`.
4. **Configure auth** with `supabase--configure_auth`: signups enabled, auto-confirm email ON (so you can test without an inbox), no anonymous, no HIBP requirement initially.
5. **Verify**: hit `/` and `/auth` via Playwright, check console for errors, confirm sign-up + sign-in work and the redirect into `_authenticated` lands on the slate page.
6. **Grant yourself admin** after first sign-in (one short SQL insert into `user_roles`) so the admin panel and ingest server fns work end-to-end.

### Preserved
- All routes (`scores`, `slate`, `matchups/$gamePk`, `players/$playerId`, `teams/$teamId`, `standings`, `odds`, `leaderboards`, `calibration`, `bets`, `_admin/admin`, `auth`)
- Diamond Engine v0.1.0 (`src/lib/engines/v0_1_0/`) and Alpha 0.3 (`src/lib/engines/alpha_0_3/`)
- Monte Carlo sim modules (`src/lib/sim/*`) and the engine registry
- Admin panel under `_authenticated/_admin/`
- Existing migration files on disk (left untouched as the source of truth)

### Out of scope (call out, not change)
- No Google OAuth wiring this turn — say the word and I'll add it via `lovable.auth.signInWithOAuth("google")`.
- No ingest / sim data populated — those run on demand from the admin panel.

Approve and I'll run the missing migration, regenerate types, configure auth, and validate.