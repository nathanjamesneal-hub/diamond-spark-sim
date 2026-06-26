# Pre-Publish Lockdown — Final Remediation Plan

Three security gaps will be closed before publish, with verification run end-to-end. No URLs change. No simulation, scoring, or UI logic changes.

## 1. New shared middleware: `requireAppMember`

New file `src/integrations/supabase/member-middleware.ts`. Layered on top of `requireSupabaseAuth`:

1. Run `requireSupabaseAuth` first → throws `Response('Unauthorized', { status: 401 })` when no valid session.
2. Call `context.supabase.rpc('is_app_member')` (zero-arg, already exists).
3. If RPC errors or returns `false` → throw `Response('Forbidden', { status: 403 })`.
4. Pass `{ supabase, userId, claims, isMember: true }` to handler.

`assertAdmin(context)` helper (existing inline pattern in `ingest.functions.ts`) stays and is layered on top of `requireAppMember` for operational/admin functions — no behavior change there.

### Apply `requireAppMember` to every private read

Add `.middleware([requireAppMember])` to:
- `src/lib/projections.functions.ts`: `getTodaysSlate`, `getCalibration`, `getPlayerProjection`, `getDiamondScores`
- `src/lib/mlb.functions.ts`: `getSchedule`, `getStandings`, `getTeam`, `getPlayer`, `getLeaderboards`
- `src/lib/sim.functions.ts`: `simulateGame`, `getSimulationLeaders`
- `src/lib/odds.functions.ts`: `getOdds`
- `src/lib/actuals.functions.ts`: `getActualsForDate`
- `src/lib/lineups/refresh.functions.ts`: `getCronStatus`
- `src/lib/lineup-status.functions.ts`: `getLineupStatus` (currently unguarded read)

Replace the `publicClient()` (anon publishable key) in `projections.functions.ts` with `context.supabase` so reads run as the signed-in member; delete the helper.

All existing mutations keep `requireSupabaseAuth` + `assertAdmin` — re-audited, no change needed.

## 2. SSR-safe route gating (no reliance on client-side `AppGate`)

Every route that loads Diamond data must sit under the integration-managed `_authenticated/` layout so SSR / prerender hits the gate before the loader runs.

Audit + move (route file renames, identical URL via re-exported route path):
- `/diamond-scores`, `/top-props`, `/odds`, `/lineup-status`, `/calibration-lab`, `/players/$id`, `/games/$id` and any other route whose loader calls a `requireAppMember` function must live under `src/routes/_authenticated/...`.
- Index `/` keeps its public landing shell; any Diamond-data loader on it is moved into a child component that calls via `useServerFn` after the gate passes, or the route itself is moved under `_authenticated/`.

`AppGate` stays as a defense-in-depth client check; it is no longer the only line of defense.

## 3. Replace DB signup-block with Supabase Before-User-Created Auth Hook

Drop the proposed `BEFORE INSERT ON auth.users` trigger plan.

Implementation:
- New server route `src/routes/api/public/hooks/before-user-created.ts` that verifies the Supabase Auth Hook HMAC header (`webhook-signature`, standard-webhooks format) and returns the documented rejection payload:
  ```json
  { "error": { "http_code": 403, "message": "Sign-ups are disabled for this app." } }
  ```
  for every request. No allowlist — even the existing admin owner is unaffected because they already exist in `auth.users` and the hook only fires on user creation.
- Configure the hook in Supabase Auth (`auth.hook_before_user_created`) to call this URL, with the hook's signing secret stored in Vault and read at runtime as `BEFORE_USER_CREATED_HOOK_SECRET`.
- Keep public signup UI removed in `src/routes/auth.tsx`. Keep email signup disabled at the Auth provider level; keep Google enabled for sign-in only (Google still triggers the hook on first-time identities, which the hook will reject — admin owner is already provisioned).
- Existing `public.block_new_signups()` function and any orphan references are dropped in the same migration to remove dead code.

## 4. Webhook secret rotation (Vault-stored)

- Generate `CRON_WEBHOOK_SECRET` (64 chars) as a server-only secret via `generate_secret`. Also mirror it into Supabase Vault (`vault.secrets`) so the cron SQL can read it without the literal value appearing in the SQL text or `cron.job` listing.
- Update `pg_cron` job (via `supabase--insert`, not migration) to fetch the secret from Vault and send `Authorization: Bearer <secret>` — no `apikey` header, no literal in SQL.
- Rewrite `src/routes/api/public/hooks/refresh-lineups.ts`:
  - Read the bearer from `Authorization`.
  - Read `process.env.CRON_WEBHOOK_SECRET` inside the handler.
  - Compare lengths first; if they differ, return a generic `new Response('Unauthorized', { status: 401 })`. Otherwise `timingSafeEqual`. Same generic response on mismatch.
  - Remove the `SUPABASE_PUBLISHABLE_KEY` branch entirely.
- Verify the secret is absent from: source files (`rg`), browser network responses (network panel), runtime logs (`server-function-logs`), and `select jobname, command from cron.job` output.

## 5. Verification matrix (returned before publish)

Run with Playwright + curl + SQL probes; report observed result per row.

| Case | Surface | Expected |
| --- | --- | --- |
| Logged out | GET `/diamond-scores`, `/top-props`, `/odds`, `/admin` | Redirect to `/auth` (SSR), no Diamond data in HTML |
| Logged out | Direct POST to `getDiamondScores` / `getSchedule` / `getSimulationLeaders` server fn | 401 |
| Signed-in non-member (fresh Google) | Protected routes | Redirect / access-denied; `is_app_member()` = false |
| Signed-in non-member | Direct private read server fn | 403 |
| Signed-in non-member | RLS probe via `context.supabase` | 0 rows on `players`, `projections` |
| Admin owner (`nathanjamesneal`) | All reads, `/admin`, `runDailyPipeline`, `lockGame`, `unlockGame` | Success |
| Webhook | POST with old publishable key in `apikey` | 401 |
| Webhook | POST with no/short/wrong `Authorization` | Generic 401, no leak |
| Webhook | POST with valid `Bearer $CRON_WEBHOOK_SECRET` | 200, refresh runs |
| Signup | Email signup via UI | Blocked at UI; if forced via GoTrue REST, hook returns 403; observed message reported verbatim |
| Signup | Google first-time sign-in for a new identity | Hook rejects; observed message reported verbatim |
| Signup | `select count(*) from auth.users` before/after each signup attempt | Unchanged |
| Secret leak | `rg CRON_WEBHOOK_SECRET src/`, browser Network, `server-function-logs`, `select command from cron.job` | No matches |

Publish only proceeds if every row passes.

## Out of scope (unchanged)
Simulation math, scoring, calibration, Diamond Engine internals, table schemas other than the migration to drop `block_new_signups()`, UI/visual design, public landing copy.
