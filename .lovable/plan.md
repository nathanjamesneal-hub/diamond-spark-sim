## Reshape `/top-props` into Category Top 25 Leaderboards

Update `src/routes/top-props.tsx` only. No engine, scoring, or server-function changes.

### Layout

1. **"Best of the Day" hero strip** (renamed from current hero). Pick the single highest-probability play per category and render the existing hero cards.
2. **Filter bar** (unchanged controls, same state):
  - Prop Type (acts as a category filter — "All" shows every section, a specific type shows only that section)
  - Team
  - Minimum Probability slider
  - Sort (Probability | Diamond Score)
3. **Category sections**, rendered in this order:
  - Home Runs (HR)
  - Hits (H)
  - Total Bases (TB)
  - RBI
  - Runs (R) — added; derived from existing projection runs field if present, otherwise section hidden gracefully
  - Stolen Bases (SB)
  - Strikeouts (pitcher Ks) — shown when pitcher projections include a K prop
  - Pitcher Props: Win, Quality Start (existing)

### Each section

- Header: category title + count badge (e.g., "Top 25 · 18 qualified").
- Grid/table capped at **25 rows**, sorted by current Sort selection, filtered by Team + Min Probability.
- Columns: Player (links to existing `/players/$mlbId`), Team, Opponent, Prop Line/Type, Diamond Score, Probability % (colored badge), Confidence badge, Edge/Value field if already present on the row.
- Empty state: "No qualified plays for this category."
- Probability badge colors preserved: ≥80% emerald, ≥65% sky, ≥50% amber, else slate/red.

### Data

- Continue consuming `getDiamondScores` via existing `useSuspenseQuery`.
- Reuse the current flatten step that produces `{player, team, opp, propType, line, prob, diamondScore, confidence, edge}` rows.
- Group by `propType`, then per group: filter (team, minProb) → sort → `slice(0, 25)`.
- Re-render automatically when lineups/pitchers refresh (query invalidation already wired from admin actions).

### Out of scope

- No changes to `getDiamondScores`, engines, projections schema, or site header.

No new server functions.

&nbsp;

Do not ask follow-up layout questions. Implement this exactly inside src/routes/top-props.tsx only. Preserve all existing imports/components when possible, and only add helper functions inside this file if needed.