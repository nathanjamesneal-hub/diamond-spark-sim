## Problem

Top Props (and every other surface that calls `getDiamondScores` / `selectBestPublicForecast`) hides games that are already in progress unless an official forecast was published before first pitch. For today's slate, several live games never got an official run — only a locked preview snapshot exists — so they vanish from Top Props the moment first pitch passes.

Today's live games and their persisted runs:

```text
gamePk 824257  In Progress  official=0  preview=1   ← dropped
gamePk 824745  In Progress  official=0  preview=1   ← dropped
gamePks 823688/823039/824014/823285/823206 (late-night carryover)  official=0  preview=0
```

The 5 carryover games have no persisted forecast at all and cannot be shown (no snapshot to read). The 2 daytime live games DO have a locked preview snapshot from before first pitch — that immutable pregame projection is exactly what should populate the leaderboard while the game is live.

## Fix (read-layer only, no engine/snapshot changes)

Loosen the public selector to allow a **locked** preview snapshot after first pitch. Locked preview rows are already immutable pregame projections — they're the same data the user saw at lineup time, just frozen by the lock-live cron. Official always still wins when present.

### Change 1 — `src/lib/forecast/select-public.ts`

In `selectBestPublicForecast`, replace the hard cutoff:

```ts
if (gameHasStartedOrPastStart(...)) return null;
const previewProjection = bestProjection(..., "preview");
```

with:

```ts
const previewProjection = bestProjection(..., "preview");
if (previewProjection) {
  const previewRun = bestRun(..., "preview");
  if (previewRun) {
    const started = gameHasStartedOrPastStart(args.gameStatus, args.firstPitchAt, args.now);
    // Post-first-pitch: only accept a locked preview snapshot (immutable pregame projection).
    // Pregame: accept locked or published preview.
    if (!started || previewRun.status === "locked") {
      return { projection: previewProjection, run: previewRun, projectionClass: "preview" };
    }
  }
}
return null;
```

Official-first priority above this block is unchanged. No engine, no simulator, no snapshot writes.

### Change 2 — surface labeling

`getDiamondScores` already derives `forecast_status` from the selected run. Add one branch in the `forecast_status` resolver (around `src/lib/projections.functions.ts:740`) so a selected preview row on a `live`/`final` game shows as `"live"` / `"final"` (locked preview = locked pregame snapshot now playing/played), not `"preview"`. The amber preview styling on Top Props/Forecast Board will then correctly flip to the live/final treatment, while the underlying data still comes from the locked preview snapshot.

Concretely: in the existing `fStatus` derivation, when `chosenClass === "preview"` and the run is `locked`, map by `gameStateOf(g.game_status)` exactly the way official locked rows are mapped (`live` → "live", `final` → "final", else "locked").

### Change 3 — Top Props copy

In `src/routes/_authenticated/top-props.tsx`, when `is_preview` is true but `forecast_status` is `"live"` or `"final"`, render the live/final pill instead of the amber "Preview" pill. (Single conditional in the existing badge renderer — no data plumbing changes.)

## Out of scope

- The 5 late-night carryover live games with zero persisted runs cannot be shown — there is no snapshot to read. They will continue to be excluded. If that matters, it's a separate fix in the orchestrator's nightly preview generation, not in the read layer.
- No changes to Alpha math, Monte Carlo math, Diamond Score, calibration, simulator runs, or forecast lifecycle writes.
- No new database columns or migrations.

## Acceptance

- The two in-progress 17:10 ET games appear in Top Props with their locked pregame preview probabilities and means.
- Pregame games still prefer Official > Preview exactly as before.
- Pregame games without a locked preview still suppress that preview after first pitch (no leaked unpublished previews).
- Forecast Board, Consensus, Sim Leaders, Detail Drawer — all surfaces that share `selectBestPublicForecast` — gain the same live-game visibility automatically.
