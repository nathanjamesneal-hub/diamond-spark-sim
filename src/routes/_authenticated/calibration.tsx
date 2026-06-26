import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getCalibration, type CalibrationRow } from "@/lib/projections.functions";

const q = queryOptions({
  queryKey: ["calibration"],
  queryFn: () => getCalibration(),
  staleTime: 5 * 60 * 1000,
});

export const Route = createFileRoute("/calibration")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Calibration · Diamond" },
      { name: "description", content: "Diamond model accuracy by stat, confidence tier, and version." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(q),
  component: CalibrationPage,
  errorComponent: ({ error }) => <div className="p-8 text-sm text-muted-foreground">Couldn't load calibration: {error.message}</div>,
  notFoundComponent: () => <div className="p-8">Not found.</div>,
});

const STAT_LABEL: Record<string, string> = {
  hit: "Hit ≥1", tb: "Total Bases ≥2", hr: "HR ≥1", rbi: "RBI ≥1", sb: "SB ≥1",
};
const STATS = ["hit", "tb", "hr", "rbi", "sb"] as const;
const BUCKETS = ["high", "med", "low"] as const;
const BUCKET_LABEL: Record<string, string> = { high: "High (75+)", med: "Med (50–74)", low: "Low (<50)" };

function CalibrationPage() {
  const { data } = useSuspenseQuery(q);
  const versions = data.versions;
  const rows = data.rows;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6">
      <div className="mb-8">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">Model accuracy · all versions</div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Calibration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Predicted probability vs. observed rate. Lower Brier = better. Sample size matters — early model runs will look noisy.
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyCalibration />
      ) : null}

      {versions.map((v) => {
        const vRows = rows.filter((r) => r.model_version === v.version);
        if (!vRows.length) return null;
        return (
          <section key={v.version} className="mb-10 rounded-lg border border-border/60 bg-card/40 p-5">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="mono text-[11px] uppercase tracking-widest text-edge">
                  v{v.version} · released {v.release_date}{v.active ? " · ACTIVE" : ""}
                </div>
                <h2 className="font-display text-xl font-semibold">Model {v.version}</h2>
                {v.notes ? <p className="text-xs text-muted-foreground">{v.notes}</p> : null}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="table-modern mono w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 text-left uppercase tracking-widest">Stat</th>
                    {BUCKETS.map((b) => (
                      <th key={b} className="px-2 py-2 text-right uppercase tracking-widest">{BUCKET_LABEL[b]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {STATS.map((stat) => (
                    <tr key={stat} className="border-t border-border/40">
                      <td className="px-2 py-2 text-left text-foreground">{STAT_LABEL[stat]}</td>
                      {BUCKETS.map((b) => {
                        const r = vRows.find((x) => x.stat === stat && x.confidence_bucket === b);
                        return <td key={b} className="px-2 py-2 text-right"><Cell row={r} /></td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Cell({ row }: { row?: CalibrationRow }) {
  if (!row || row.sample_size === 0) return <span className="text-muted-foreground/60">—</span>;
  const p = row.predicted_mean ?? 0;
  const o = row.observed_mean ?? 0;
  const diff = o - p;
  return (
    <div className="leading-tight">
      <div className="text-foreground">pred {(p * 100).toFixed(0)}% · obs {(o * 100).toFixed(0)}%</div>
      <div className={diff >= 0 ? "text-edge" : "text-destructive"}>
        Δ {diff >= 0 ? "+" : ""}{(diff * 100).toFixed(1)}pp · n={row.sample_size}
      </div>
    </div>
  );
}

function EmptyCalibration() {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-card/30 p-10 text-center">
      <div className="mono text-xs uppercase tracking-widest text-muted-foreground">No calibration data yet</div>
      <p className="mt-2 text-sm text-muted-foreground">
        Run the engine for a few days, import results, then run calibration from the admin panel.
      </p>
    </div>
  );
}
