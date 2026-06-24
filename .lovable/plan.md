## Plan to unblock the app

### Goal
Stop the root “Rain delay” screen from taking over the app on mobile/editor preview, especially on `/` and `/auth`, so you can reach the sign-in screen and navigate normally.

### What I found
- The current live signal is still `Error in route match: __root__/`, meaning the shared root shell is crashing, not just one page.
- `/auth` is already marked client-only, so the likely crash path is shared UI that renders on every page — especially `SiteHeader` or router-level error handling.
- The header currently calls auth/admin checks after mount and has no error guards around those calls.
- The root error boundary exists, but there is no router-level `defaultErrorComponent` fallback if the root boundary itself or shared shell fails.

### Changes to make
1. **Harden the shared header**
   - Wrap `supabase.auth.getUser()`, `onAuthStateChange`, admin RPC checks, and sign-out in safe `try/catch` handling.
   - Ensure failed auth/admin checks do not throw into the root route.
   - Treat admin lookup failures as “not admin” instead of crashing the page.

2. **Add a router-level fallback error boundary**
   - Add `defaultErrorComponent` in `src/router.tsx` with the same “Rain delay” recovery actions.
   - This catches cases where a route/shared shell error bypasses or breaks the root route boundary.

3. **Make root fallback safer**
   - Keep diagnostics, but guard error rendering so unusual non-Error values cannot crash the fallback itself.
   - Use reliable hard-navigation fallback for “Go home”.

4. **Verify the mobile flow**
   - Open `/` and `/auth` in a mobile viewport.
   - Confirm the sign-in screen is reachable and the Rain delay screen is gone.
   - Check console/runtime signals for any remaining root route error.

### Out of scope
- No Diamond Engine changes.
- No projection/data pipeline changes.
- No schema/RLS changes.
- No visual redesign beyond safer error recovery UI.