## Root-cause hypotheses (ranked)

Investigation of `src/components/app-gate.tsx`, `src/routes/auth.tsx`, and `src/routes/__root.tsx` plus the published-only nature of the failure points to two compounding issues. I'll confirm with live tests against `https://diamond-spark-sim.lovable.app` before changing code, but the likely causes are:

1. **Supabase Auth redirect allowlist missing the production domain.** OAuth/email links currently work in the editor preview because that origin is allowlisted; mobile Safari on the published URL is a different origin. If `https://diamond-spark-sim.lovable.app` and `/**` aren't on the Site URL / Additional Redirect URLs list, Google returns to the published origin but Supabase rejects the redirect and never sets the session cookie.

2. **AppGate races + auto sign-out on transient errors.**
   - `evaluate()` runs `supabase.auth.getUser()` immediately on mount. On mobile Safari after a full-page Google redirect, the Lovable wrapper sets the session asynchronously, so the first `getUser()` returns `null` → AppGate `router.navigate({ to: "/auth" })`. `onAuthStateChange("SIGNED_IN")` fires moments later, but the user is already parked on `/auth` and sees the sign-in form again (looks like "login failed").
   - When `supabase.rpc("is_app_member")` errors for ANY reason (network hiccup, cold start, mobile data flake), AppGate calls `supabase.auth.signOut()`. On flaky mobile networks this turns a transient blip into a hard sign-out loop.
   - Email/password path calls `navigate({ to: "/bets" })` BEFORE AppGate's next `evaluate()` has confirmed membership, so the same `getUser()` race can bounce the user back to `/auth`.

## Diagnostic pass (no code changes)

Before editing, I'll run these against the published URL and report the test matrix:

- Use Playwright with a mobile Safari user-agent + viewport against `https://diamond-spark-sim.lovable.app/auth`, attempt email/password sign-in with the owner account, capture network + console, screenshot each step.
- Inspect Supabase Auth config (`supabase--project_info` / `configure_auth`) to read Site URL and Additional Redirect URLs.
- Verify `user_roles` still has the owner's `admin` row and `is_app_member()` returns true for that uid via `supabase--read_query`.
- Confirm the published bundle is the latest commit (no stale AppGate).

Report per step: expected, observed, route/redirect URL, error, whether a Supabase session exists.

## Narrow fix (only after diagnostics confirm)

### A. Supabase Auth redirect configuration
Ensure exactly:
- Site URL: `https://diamond-spark-sim.lovable.app`
- Additional Redirect URLs (preserve existing dev entries, add if missing):
  - `https://diamond-spark-sim.lovable.app/**`
  - existing `id-preview--0bdb12d7-...lovable.app/**`
  - existing `http://localhost:*/**`

No change to providers, signup-disabled, or HIBP settings.

### B. `src/components/app-gate.tsx` — tighten the gate, stop the sign-out loop
- Subscribe to `onAuthStateChange` FIRST, then call `getUser()` (recommended Supabase pattern). This eliminates the post-OAuth race where the first `getUser()` returns null on mobile.
- Treat `INITIAL_SESSION` and `TOKEN_REFRESHED` events as identity signals too, but only re-evaluate when a session actually exists.
- If `supabase.rpc("is_app_member")` returns an **error** (network/transport), keep status `loading` and retry once with backoff — DO NOT sign out. Only sign out when the RPC succeeds and returns `false` (true non-member).
- While `status === "loading"`, never call `router.navigate({ to: "/auth" })`. Only navigate after we have a definitive `getUser()` + RPC result.
- Keep behavior for: 401 logged-out → redirect to `/auth`; 403 non-member → sign out + redirect.

### C. `src/routes/auth.tsx` — wait for confirmed session before navigating
- After `signInWithPassword` succeeds, await `supabase.auth.getUser()` (revalidates) before `navigate({ to: "/bets" })`. Prevents the AppGate race on the destination route.
- Leave Google flow as-is (`redirect_uri: window.location.origin`), since the fix in (B) covers the post-redirect race.

No other files touched. No changes to RLS, `is_app_member()`, signup-disabled config, engines, or data.

## Verification

After applying:
- Playwright against the published URL with a mobile Safari UA: email/password sign-in → lands on `/bets` with projections visible; reload `/diamond-scores` directly stays signed in.
- Confirm logged-out hitting `/diamond-scores` still redirects to `/auth` (401 preserved).
- Confirm a non-member google account would still be signed out + redirected (simulated by temporarily flipping the RPC return in a read-only test query; no policy change).
- Ask you to retest on iPhone Safari at `https://diamond-spark-sim.lovable.app`.

## Technical notes
- `lovable.auth.signInWithOAuth` handles the iframe-safe and full-page flows; we do not change it. The race is downstream in AppGate, not in the OAuth helper.
- The "Lovable preview fetch proxy" Stack-Overflow note doesn't apply here — the failure is on the published origin, not the preview.
