/**
 * Collapsible Simulation Details block.
 * Surfaces the existing Monte Carlo outputs (mean / median / stdev / p90)
 * when available; renders "—" placeholders otherwise. Display-only.
 */
type Props = {
  iterations?: number;
  mean: number | null;
  median: number | null;
  stdev: number | null;
  percentile90: number | null;
  fractionDigits?: number;
};

const ITERATIONS_DEFAULT = 2000;

function fmt(n: number | null, digits: number): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function SimDetails({
  iterations = ITERATIONS_DEFAULT,
  mean,
  median,
  stdev,
  percentile90,
  fractionDigits = 2,
}: Props) {
  return (
    <details className="mt-2 rounded-md border border-border/60 bg-card/40 px-2 py-1.5 text-xs">
      <summary className="mono cursor-pointer text-[10px] uppercase tracking-widest text-muted-foreground">
        Simulation Details
      </summary>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={`Sims run`} v={iterations.toLocaleString()} />
        <Stat label="Mean" v={fmt(mean, fractionDigits)} />
        <Stat label="Median" v={fmt(median, fractionDigits)} />
        <Stat label="Std Dev" v={fmt(stdev, fractionDigits)} />
        <Stat label="p90" v={fmt(percentile90, fractionDigits)} />
      </div>
      <div className="mt-2 rounded-md border border-dashed border-border/50 bg-secondary/20 p-2 text-[10px] text-muted-foreground">
        Distribution chart coming soon.
      </div>
    </details>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded bg-secondary/40 px-2 py-1">
      <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mono mt-0.5 tabular-nums">{v}</div>
    </div>
  );
}
