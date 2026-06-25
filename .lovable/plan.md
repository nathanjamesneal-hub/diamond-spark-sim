Verify the existing Model Readout implementation in `src/routes/calibration-lab.tsx` and confirm it matches the requested behavior, then polish any wording or layout if needed.

### What’s already in place
The file already contains:
- `takeawayForCell(c: Cell)` with the exact rule set: small sample (<25), overconfident (≤-15pp), underestimating (≥15pp), well calibrated (|Δ|≤5pp), slight drift (5–15pp).
- A per-stat "Model readout" block under each `StatCard` table, listing HIGH/MED/LOW takeaways.
- A top-level summary card with best calibrated stat, worst calibrated stat, and overall bias (signed pp + "overconfident"/"underestimating").

### Steps
1. Confirm the thresholds and formulas against the live data shape (`CalibrationRow`, predicted_mean, observed_mean, sample_size, brier_score).
2. Verify the summary math: per-stat average absolute delta, best/worst selection, and overall signed bias across populated buckets.
3. Check that HR LOW bucket is still excluded from grading as required by the existing HR rule.
4. Optionally tweak plain-English wording or visual hierarchy if the current sports-analytics language needs adjustment.

### No new scaffolding required
- Only `src/routes/calibration-lab.tsx` is in scope.
- No new dependencies, routes, or backend functions.
- If a build check is needed after any edit, run `bunx tsc --noEmit`.