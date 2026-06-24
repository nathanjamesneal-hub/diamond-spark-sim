# Diamond Baseball Engine — Import Plan

## Goal
Import the uploaded ZIP exactly as-is into this Lovable project, preserving all folder structure, routes, engines, simulation code, migrations, tests, auth, and admin panel. No regeneration, no rewrites.

## Step 1 — Wipe the starter scaffold
The current project is the default TanStack Start blank app. Before extracting, remove the conflicting starter files so they don't collide with the import:
- `src/routes/index.tsx`, `src/routes/__root.tsx`, `src/routeTree.gen.ts`
- `src/router.tsx`, `src/start.ts`, `src/server.ts`, `src/styles.css`
- `src/lib/*` (keep nothing — the upload replaces all of it)
- `package.json`, `bun.lock`, `tsconfig.json`, `vite.config.ts`, `components.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.gitignore`, `AGENTS.md`

Keep: `.lovable/project.json` (project identity).

## Step 2 — Extract the ZIP into the project root
Unzip `diamond-baseball-engine-live-stats-update.zip` to `/dev-server/`, preserving the exact tree. Verify `.git` is not present in the archive before copying (it isn't, per the listing).

Files that land:
- `src/routes/` — index, auth, scores, standings, slate, odds, calibration, leaderboards, matchups.$gamePk, players.$playerId, teams.$teamId, `_authenticated/route.tsx`, `_authenticated/bets.tsx`, `_authenticated/_admin/{route,admin}.tsx`
- `src/lib/engines/v0_1_0/engine.ts` — Diamond Engine v0.1.0
- `src/lib/engines/alpha_0_3/{engine.ts,engine.test.ts}` — Alpha 0.3 + tests
- `src/lib/engines/{registry.ts,registry.test.ts}` — engine registry (controls active engine)
- `src/lib/sim/{engine.ts,environment.ts,league.ts,park-factors.ts}` — Monte Carlo core
- `src/lib/{sim,projections,ingest,mlb,bets,odds,game-environment}.functions.ts` and helpers
- `src/integrations/supabase/{client,client.server,auth-attacher,auth-middleware,types}.ts`
- `supabase/migrations/*.sql` (4 migrations incl. `20260624000000_diamond_engine_alpha_0_3.sql`)
- All shadcn UI components, hooks, config files

## Step 3 — Install dependencies
Run `bun install` against the imported `package.json` / `bun.lock` so the lockfile is honored.

## Step 4 — Connect YOUR existing Supabase project (REQUIRED, blocks DB work)
Per your instructions, this app must use your own Supabase, NOT Lovable Cloud. Lovable Cloud is disabled for your account, so there is nothing to opt out of — I just need credentials for your existing project.

I will request these as project secrets via `add_secret` so the existing `src/integrations/supabase/client.ts` and `client.server.ts` pick them up:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY` (anon/publishable key — safe in client)
- `VITE_SUPABASE_PROJECT_ID`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only, used by `client.server.ts` and admin routes)

You'll get these from Supabase Dashboard → Project Settings → API. I will NOT create a new Supabase project and will NOT run any migrations until you've provided these.

Migrations in `supabase/migrations/` are committed source — applying them against your project is done via the Supabase CLI (`supabase db push`) from your local machine, not from Lovable. I'll surface the four migration filenames and let you run the push.

## Step 5 — Validation (read-only, no code changes)
After import + install + secrets:
1. Compile check via the harness build output (TanStack regenerates `routeTree.gen.ts` from `src/routes/`).
2. Confirm route files present: `/`, `/auth`, `/scores`, `/standings`, `/slate`, `/odds`, `/calibration`, `/leaderboards`, `/matchups/$gamePk`, `/players/$playerId`, `/teams/$teamId`, `/bets` (authed), `/_admin` (authed).
3. Confirm Supabase client reads `VITE_SUPABASE_*` — quick `rg` to verify.
4. Confirm `src/lib/engines/registry.ts` lists both `v0_1_0` and `alpha_0_3`, with `alpha_0_3` flagged inactive by default (I'll inspect the file and report; will NOT modify unless you ask).
5. Confirm Monte Carlo modules under `src/lib/sim/` are intact (engine, environment, league, park-factors).
6. Confirm `_authenticated/_admin/route.tsx` admin gate is wired.
7. Confirm 4 migrations present in `supabase/migrations/`.

## Stop conditions
If any of the following happen, I stop and report before touching code:
- Build fails after a clean import (likely a missing dep or a Supabase env not yet set — expected until Step 4 completes).
- `registry.ts` shows Alpha 0.3 as the active default (you said it should be inactive).
- A file listed in the ZIP fails to land in the project tree.
- Supabase types/migrations reference tables the existing client code doesn't expect.

## What I will NOT do
- Regenerate any code.
- Edit any engine, simulation, migration, or route file.
- Create or modify a Supabase project on your behalf.
- Run `supabase db push` for you (your DB, your credentials).
