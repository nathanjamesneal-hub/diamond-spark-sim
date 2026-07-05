## Apply mlb-pulse.patch

Apply the uploaded patch verbatim, skipping any hunks that touch forbidden files, then verify the route works.

### Steps

1. **Copy patch** from `/mnt/user-uploads/mlb-pulse.patch` to `/tmp/mlb-pulse.patch` and inspect the full contents.
2. **Strip forbidden hunks** if present: any hunks touching `src/lib/engines/petri_v0_2_shadow/types.ts` or `src/routeTree.gen.ts`.
3. **Apply patch** with `git apply --reject --whitespace=nowarn /tmp/mlb-pulse.patch`.
   - If any hunk rejects because target code has drifted, **stop immediately** and report the rejected file/hunk. Do not attempt to reconcile by rewriting unrelated code.
4. **Expected file changes**:
   - edit `src/components/site-header.tsx` (add MLB Pulse nav item)
   - edit `src/lib/actuals.functions.ts` (extend HitterActual/PitcherActual)
   - edit `src/lib/mlb.functions.ts`
   - create `src/lib/pulse.functions.ts`
   - create `src/lib/pulse.test.ts`
   - create `src/lib/pulse.ts`
   - create `src/routes/_authenticated/mlb-pulse.tsx`
5. **Let `routeTree.gen.ts` regenerate** via the TanStack Router Vite plugin on the next dev run — no manual edits.
6. **Compile check** — harness runs typecheck automatically after edits.
7. **Runtime verification** via Playwright with the injected Supabase session:
   - Navigate to `http://localhost:8080/mlb-pulse`, screenshot.
   - Confirm the nav link renders and the page mounts.
   - Confirm today's game cards render with real team names and status labels (Live / Final / Scheduled).
   - Confirm the Pulse server function returns a success payload (no error boundary, no red error text in the page's main container).
   - Trigger the manual refresh control and confirm the freshness timestamp updates.
   - **Forbidden-term scan — scoped to the Pulse page's main content container only** (not the global header/nav): assert absence of "Diamond Score", "odds", "probability", "parlay", "consensus", and forecast-related card/content labels. The global nav's "Forecasts" link is legitimate and does not count.
   - Lineup label check: labels appearing on Pulse must be exactly one of "Official", "Projected from prior lineup", or "Waiting for verified data".
   - Source-level check of `mlb-pulse.tsx`: 60s `refetchInterval` is gated on `hasLiveGames && document.visibilityState === "visible"`, and a manual refresh button exists.
8. **Do NOT require** a direct browser network request to `statsapi.mlb.com` as proof — the MLB fetch happens inside the server function. Server-function success + rendered game cards is the evidence.

### Report back

- Files applied / any rejected hunks (with stop-and-report behavior on drift)
- Whether `routeTree.gen.ts` regenerated automatically (contains `/mlb-pulse` entry) without manual edits
- Whether `/mlb-pulse` rendered successfully (screenshot)
- Any API/runtime errors from console or server-function logs
- Confirmation of scoped forbidden-term scan, lineup labels, and refresh policy

### Non-goals

- No redesign of the Pulse page
- No changes to Petri, Alpha, forecasts, odds, or any other existing surface
- No hand-edits to `routeTree.gen.ts`
