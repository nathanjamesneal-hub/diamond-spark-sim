/** Plain-English explainer reused on Lab pages so Diamond Score never gets
 *  confused with raw or calibrated probability. */
export function LayerLegend() {
  return (
    <div className="rounded-lg border border-border/60 bg-card/60 p-4 text-xs leading-relaxed text-muted-foreground">
      <div className="mono mb-2 text-[10px] uppercase tracking-[0.22em] text-foreground/80">
        How to read these numbers
      </div>
      <ul className="grid gap-1 md:grid-cols-3">
        <li>
          <span className="font-semibold text-foreground">Alpha Engine</span> —
          raw baseball-projection inputs and the baseline probability the
          model believes for each event (e.g. Hit 1+).
        </li>
        <li>
          <span className="font-semibold text-foreground">Monte Carlo</span> —
          the persisted distribution and mean for each stat, drawn from many
          simulated game environments at lock time.
        </li>
        <li>
          <span className="font-semibold text-foreground">Diamond Score</span> —
          a ranking / conviction layer over those outputs. It does not replace
          or recalibrate the Alpha probability.
        </li>
      </ul>
    </div>
  );
}
