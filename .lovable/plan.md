## Goal
Refine the Result grading on `/odds` (Sim Leaders) so low-mean counting projections are not counted as "Met/Beat Projection" hits, and HR/SB use simple binary event grading. Display-only — no engine, math, or projection changes.

## Scope
Single file: `src/routes/odds.tsx` (plus a one-line tooltip string reuse). No changes to `sim.functions.ts`, `actuals.functions.ts`, or engines.

## Grading rules (new)

**Counting stats** — applies to: Hits, RBI, Runs, Total Bases, Batter Strikeouts, Pitcher Strikeouts, Pitcher Outs, Earned Runs, Walks.

- If game not Final → `Pending` (muted), unchanged.
- If mean or actual missing → `—` (muted), unchanged.
- If `mean < 0.5`:
  - actual `== 0` → **Low Projection / No Event** (neutral gray, muted tone).
  - actual `> 0` → **Beat Low Projection** (green, good tone).
  - These rows are flagged `excludeFromAccuracy: true` so any future summary won't count them as hits.
- If `mean >= 0.5`: existing `gradeCounting` logic (Beat / Met / Close / Missed).

**HR** — pure binary event:
- actual `>= 1` → **Hit HR** (green, strong tone).
- actual `== 0` → **No HR** (red, bad tone).
- (Removes the current `mean >= 0.25` gating.)

**SB** — pure binary event (new, currently uses counting):
- actual `>= 1` → **Stole Base** (green, strong tone).
- actual `== 0` → **No SB** (red, bad tone).

**Binary props (QS, Win)** — unchanged.

## Implementation details (technical)

In `src/routes/odds.tsx`:

1. Extend the `Grade` type:
   ```ts
   type Grade = {
     label: "Beat Projection" | "Met Projection" | "Close" | "Missed"
          | "Low Projection / No Event" | "Beat Low Projection"
          | "Hit HR" | "No HR" | "Stole Base" | "No SB"
          | "Pending" | "—";
     tone: "strong" | "good" | "warn" | "bad" | "muted";
     excludeFromAccuracy?: boolean;
   };
   ```
2. Rewrite `gradeCounting(mean, actual)` to branch on `mean < 0.5` per rules above.
3. Replace `gradeHR` with binary event logic (drop the 0.25 gate).
4. Add `gradeSB(actual)` mirroring HR; route `sb` category through it (it currently falls through to `gradeCounting`).
5. Wire the per-row grading switch at the row render site:
   - `cat.key === "hr"` → `gradeHR`
   - `cat.key === "sb"` → `gradeSB`
   - `cat.getBoolActual` → `gradeBinary` (QS, Win)
   - else → updated `gradeCounting`
6. Add the methodology tooltip next to the **Result** column header in `CategorySection`:
   > "Low mean projections below 0.5 are treated as neutral when the event does not occur, so the model does not receive false-positive credit for predicting near-zero outcomes."
   
   Implemented as a small inline `<span title="…">i</span>` matching the existing `SimMethodologyTooltip` visual style (or a second tooltip component co-located in the file) so we don't broaden `SimMethodologyTooltip`'s contract.

No `GRADE_CLASS` changes required — new labels reuse existing `muted` / `good` / `strong` / `bad` tones.

## Out of scope
- Earned Runs and Walks categories are listed in the requirements but are not currently in `CATEGORIES`. The grading function will support them so they Just Work if/when added, but I won't add new leaderboard categories in this pass unless you want them.
- No changes to the "Actual" column rendering.
- No changes to model math, projections, or accuracy summary screens (none currently consume per-row grade results).

## Verification
- Typecheck.
- Spot-check `/odds` for a past date with Final games: confirm low-mean rows show the new neutral/green labels and HR/SB rows show binary labels.
