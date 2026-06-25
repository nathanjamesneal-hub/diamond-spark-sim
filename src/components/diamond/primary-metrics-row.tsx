/**
 * Primary Metrics row for player cards and player pages.
 * Order: Diamond Score · Mean Projection · Sim Probability · Confidence · Edge.
 * All values are simulation outputs; this component is presentational only.
 */
import { SimMethodologyTooltip } from "./sim-methodology-tooltip";

type Props = {
  diamondScore: number | null;
  meanProjection: number | null;
  meanLabel?: string; // e.g. "Mean HR", "Mean H"
  meanFractionDigits?: number;
  probability: number | null; // 0–1 or 0–100
  probabilityLabel?: string; // e.g. "HR Probability"
  confidence: number | null; // 0–100
  edge: number | null;
};

function fmtPct(p: number | null): string {
  if (p == null || !isFinite(p)) return "—";
  const v = p <= 1 ? p * 100 : p;
  return `${v.toFixed(0)}%`;
}
function fmtNum(n: number | null, digits = 2): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function PrimaryMetricsRow({
  diamondScore,
  meanProjection,
  meanLabel = "Mean Projection",
  meanFractionDigits = 2,
  probability,
  probabilityLabel = "Sim Probability",
  confidence,
  edge,
}: Props) {
  return (
    <div className="rounded-md border border-border/60 bg-secondary/30 p-2">
      <div className="mono mb-1 flex items-center gap-1 text-[9px] uppercase tracking-widest text-muted-foreground">
        <span>Primary Metrics</span>
        <SimMethodologyTooltip />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Cell label="Diamond" v={diamondScore == null ? "—" : Math.round(diamondScore).toString()} accent="primary" />
        <Cell label={meanLabel} v={fmtNum(meanProjection, meanFractionDigits)} accent="edge" />
        <Cell label={probabilityLabel} v={fmtPct(probability)} />
        <Cell label="Confidence" v={confidence == null ? "—" : `${Math.round(confidence)}`} />
        <Cell label="Edge" v={edge == null ? "—" : (edge >= 0 ? `+${edge.toFixed(1)}` : edge.toFixed(1))} muted={edge == null} />
      </div>
    </div>
  );
}

function Cell({ label, v, accent, muted }: { label: string; v: string; accent?: "primary" | "edge"; muted?: boolean }) {
  const color = accent === "primary" ? "text-primary" : accent === "edge" ? "text-edge" : "text-foreground";
  return (
    <div className="rounded bg-card/60 px-2 py-1">
      <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`mono text-base font-bold tabular-nums ${muted ? "text-muted-foreground italic" : color}`}>{v}</div>
    </div>
  );
}
