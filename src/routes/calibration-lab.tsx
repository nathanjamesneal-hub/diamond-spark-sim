import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getCalibration, type CalibrationRow } from "@/lib/projections.functions";

const q = queryOptions({
  queryKey: ["calibration"],
  queryFn: () => getCalibration(),
  staleTime: 5 * 60 * 1000,
});

export const Route = createFileRoute("/calibration-lab")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Calibration Lab · Diamond" },
      { name: "description", content: "Hitter model calibration: predicted vs. observed by stat and probability bucket." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(q),
  component: CalibrationLabPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load calibration: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">Not found.</div>,
});

type StatKey = "hit" | "tb" | "hr" | "rbi" | "sb";
type BucketKey = "high" | "med" | "low";

const STATS: { key: StatKey; label: string; sub: string }[] = [
  { key: "hit", label: "Hit ≥1", sub: "At least one hit" },
  { key: "tb", label: "Total Bases ≥2", sub: "2+ total bases" },
  { key: "hr", label: "HR ≥1", sub: "At least one home run" },
  { key: "rbi", label: "RBI ≥1", sub: "At least one RBI" },
  { key: "sb", label: "SB ≥1", sub: "At least one stolen base" },
];

const BUCKETS: { key: BucketKey; label: string; range: string }[] = [
  { key: "high", label: "HIGH", range: "≥ 75%" },
  { key: "med", label: "MED", range: "50–74%" },
  { key: "low", label: "LOW", range: "< 50%" },
];

type Cell = {
  predictedPct: number | null;
  observedPct: number | null;
  observedHits: number | null;
  deltaPp: number | null;
  sampleSize: number;
  brier: number | null;
  excluded?: boolean;
  excludedLabel?: string;
};

function toCell(r: CalibrationRow | undefined, opts?: { excluded?: boolean; excludedLabel?: string }): Cell {
  if (opts?.excluded) {
    return {
      predictedPct: null, observedPct: null, observedHits: null, deltaPp: null,
      sampleSize: r?.sample_size ?? 0, brier: null,
      excluded: true, excludedLabel: opts.excludedLabel,
    };
  }
  if (!r || !r.sample_size) {
    return { predictedPct: null, observedPct: null, observedHits: null, deltaPp: null, sampleSize: 0, brier: r?.brier_score ?? null };
  }
  const p = (r.predicted_mean ?? 0) * 100;
  const o = (r.observed_mean ?? 0) * 100;
  const hits = Math.round((r.observed_mean ?? 0) * r.sample_size);
  return {
    predictedPct: p,
    observedPct: o,
    observedHits: hits,
    deltaPp: o - p,
    sampleSize: r.sample_size,
    brier: r.brier_score,
  };
}

function deltaTone(deltaPp: number | null): { className: string; badge: string } {
  if (deltaPp == null) return { className: "text-muted-foreground", badge: "bg-muted/40 text-muted-foreground" };
  const a = Math.abs(deltaPp);
  if (a <= 5) return { className: "text-emerald-400", badge: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30" };
  if (a <= 15) return { className: "text-amber-400", badge: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30" };
  return { className: "text-rose-400", badge: "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30" };
}

function gradeFor(avgAbs: number | null): { grade: string; tone: string } {
  if (avgAbs == null) return { grade: "—", tone: "text-muted-foreground" };
  if (avgAbs <= 5) return { grade: "A", tone: "text-emerald-400" };
  if (avgAbs <= 10) return { grade: "B", tone: "text-lime-400" };
  if (avgAbs <= 15) return { grade: "C", tone: "text-amber-400" };
  if (avgAbs <= 25) return { grade: "D", tone: "text-orange-400" };
  return { grade: "F", tone: "text-rose-400" };
}

function CalibrationLabPage() {
  const { data } = useSuspenseQuery(q);
  const versions = data.versions;
  const activeVersion = versions.find((v) => v.active)?.version ?? versions[0]?.version ?? "";
  const [version, setVersion] = useState<string>(activeVersion);

  const rows = useMemo(() => data.rows.filter((r) => r.model_version === version), [data.rows, version]);

  const grid = useMemo(() => {
    const map: Record<StatKey, Record<BucketKey, Cell>> = {} as any;
    for (const s of STATS) {
      map[s.key] = { high: toCell(undefined), med: toCell(undefined), low: toCell(undefined) };
      for (const b of BUCKETS) {
        const r = rows.find((x) => x.stat === s.key && x.confidence_bucket === b.key);
        map[s.key][b.key] = toCell(r);
      }
    }
    return map;
  }, [rows]);

  const { avgAbs, totalN } = useMemo(() => {
    let sum = 0;
    let count = 0;
    let n = 0;
    for (const s of STATS) {
      for (const b of BUCKETS) {
        const c = grid[s.key][b.key];
        if (c.deltaPp != null && c.sampleSize > 0) {
          sum += Math.abs(c.deltaPp);
          count += 1;
          n += c.sampleSize;
        }
      }
    }
    return { avgAbs: count ? sum / count : null, totalN: n };
  }, [grid]);

  const grade = gradeFor(avgAbs);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">Hitter model validation</div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Calibration Lab</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Predicted vs. observed rates, bucketed by the individual prop's predicted probability.
          </p>
        </div>
        {versions.length > 0 ? (
          <label className="mono flex items-center gap-2 text-[11px] uppercase tracking-widest text-muted-foreground">
            Model
            <select
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              className="rounded-md border border-border/60 bg-card px-2 py-1.5 text-xs text-foreground"
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}{v.active ? " · active" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-border/60 bg-card/60 p-5">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Overall grade</div>
          <div className={`font-display text-5xl font-bold leading-none ${grade.tone}`}>{grade.grade}</div>
          <div className="mt-2 text-xs text-muted-foreground">
            {avgAbs == null ? "No samples yet." : `Avg |Δ| ${avgAbs.toFixed(1)} pp across populated buckets.`}
          </div>
        </div>
        <div className="rounded-xl border border-border/60 bg-card/60 p-5">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Total events graded</div>
          <div className="font-display text-3xl font-bold">{totalN.toLocaleString()}</div>
          <div className="mt-2 text-xs text-muted-foreground">Aggregate sample across all stat × bucket cells.</div>
        </div>
        <div className="rounded-xl border border-border/60 bg-card/60 p-5">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Color key</div>
          <div className="mt-2 flex flex-col gap-1.5 text-xs">
            <span><span className="mono mr-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300 ring-1 ring-emerald-500/30">≤ 5pp</span>well calibrated</span>
            <span><span className="mono mr-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300 ring-1 ring-amber-500/30">5–15pp</span>drift</span>
            <span><span className="mono mr-2 rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-300 ring-1 ring-rose-500/30">&gt; 15pp</span>miscalibrated</span>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {STATS.map((s) => (
          <StatCard key={s.key} stat={s} buckets={grid[s.key]} />
        ))}
      </section>

      <section className="mt-8 rounded-xl border border-border/60 bg-card/40 p-5">
        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Notes</div>
        <ul className="mt-3 space-y-2 text-sm text-foreground/90">
          <li>• HR model is currently best calibrated.</li>
          <li>• Hit and Total Bases models are overconfident.</li>
          <li>• SB model is underestimating steal outcomes.</li>
          <li className="text-muted-foreground">• Sample size warning: results are noisy under n=100.</li>
        </ul>
      </section>
    </div>
  );
}

function StatCard({ stat, buckets }: { stat: { key: StatKey; label: string; sub: string }; buckets: Record<BucketKey, Cell> }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-5">
      <div className="mb-4">
        <div className="mono text-[10px] uppercase tracking-widest text-edge">{stat.sub}</div>
        <h2 className="font-display text-lg font-semibold">{stat.label}</h2>
      </div>
      <table className="mono w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-1 py-1.5 text-left uppercase tracking-widest">Bucket</th>
            <th className="px-1 py-1.5 text-right uppercase tracking-widest">Pred</th>
            <th className="px-1 py-1.5 text-right uppercase tracking-widest">Obs</th>
            <th className="px-1 py-1.5 text-right uppercase tracking-widest">Δpp</th>
            <th className="px-1 py-1.5 text-right uppercase tracking-widest">n</th>
            <th className="px-1 py-1.5 text-right uppercase tracking-widest">Brier</th>
          </tr>
        </thead>
        <tbody>
          {BUCKETS.map((b) => {
            const c = buckets[b.key];
            const tone = deltaTone(c.deltaPp);
            const lowN = c.sampleSize > 0 && c.sampleSize < 100;
            return (
              <tr key={b.key} className="border-t border-border/40">
                <td className="px-1 py-2 text-left">
                  <div className="flex items-center gap-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${tone.badge}`}>{b.label}</span>
                    <span className="text-[10px] text-muted-foreground">{b.range}</span>
                  </div>
                </td>
                <td className="px-1 py-2 text-right text-foreground">
                  {c.predictedPct == null ? "—" : `${c.predictedPct.toFixed(0)}%`}
                </td>
                <td className="px-1 py-2 text-right text-foreground">
                  {c.observedPct == null ? "—" : `${c.observedPct.toFixed(0)}%`}
                </td>
                <td className={`px-1 py-2 text-right ${tone.className}`}>
                  {c.deltaPp == null ? "—" : `${c.deltaPp >= 0 ? "+" : ""}${c.deltaPp.toFixed(1)}`}
                </td>
                <td className={`px-1 py-2 text-right ${lowN ? "text-amber-400" : "text-muted-foreground"}`}>
                  {c.sampleSize > 0 ? c.sampleSize.toLocaleString() : "—"}
                  {lowN ? "*" : ""}
                </td>
                <td className="px-1 py-2 text-right text-muted-foreground">
                  {c.brier == null ? "—" : c.brier.toFixed(3)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
