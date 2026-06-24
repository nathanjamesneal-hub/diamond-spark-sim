## Diagnosis

The "Rain delay" page is the root `errorComponent` firing. The console shows `Error in route match: __root__/`, meaning the **index route's loader/query is throwing into the error boundary**.

The index page (and `/scores`) use:

```ts
const scheduleQuery = queryOptions({
  queryKey: ["schedule", "today"],
  queryFn: () => getSchedule({ data: {} }),
  refetchInterval: 15_000,
});
...
useSuspenseQuery(scheduleQuery)
```

Two things combine to produce the symptom the user describes ("loads fine, then a few minutes later goes to Rain delay"):

1. `getSchedule` calls the MLB Stats API every 15 seconds. Any transient failure (network blip, MLB 5xx, timeout, rate-limit) makes the server fn throw.
2. `useSuspenseQuery` **rethrows refetch errors by default**, which bubbles past the route's own `errorComponent` up to the root error boundary — exactly the "Rain delay" screen.

So the page works on first load, then dies on the next failed 15s refetch. Same risk exists on `/scores`.

## Fix (display layer only — no engine, schema, or auth changes)

1. **Stop background refetches from killing the page.** Update the `scheduleQuery` factories in `src/routes/index.tsx` and `src/routes/scores.tsx` to:
   - Add `retry: 2` with a small backoff.
   - Add `throwOnError: (_err, query) => query.state.data === undefined` so only the *initial* fetch can trigger the error boundary; later failed refetches keep showing the last successful slate.
   - Add `refetchOnWindowFocus: false` to avoid duplicate refetch storms.

2. **Harden `getSchedule` against partial MLB outages** in `src/lib/mlb.functions.ts`:
   - Wrap the main `/schedule` fetch in try/catch; on failure return `{ date, games: [] }` instead of throwing. The page already renders an empty-state ("Off day") for zero games, so the UI degrades cleanly instead of crashing.
   - The live-state fetches are already `Promise.allSettled`, so they're fine.

3. **Verify**: typecheck, then load `/` and `/scores`, wait through at least one refetch cycle, confirm no Rain delay. Confirm `/slate`, `/calibration`, `/admin`, `/diamond-scores` still render. Do not touch Diamond Engine, projections, or auth.

## Out of scope

- No formula, schema, route-tree, auth, or engine-registry changes.
- Monte Carlo, Diamond Engine v0.1.0, and Alpha 0.3 untouched.
