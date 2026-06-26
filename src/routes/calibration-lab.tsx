import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getCalibration, type CalibrationRow } from "@/lib/projections.functions";
import { getSimulationLeaders } from "@/lib/sim.functions";
import { getActualsForDate } from "@/lib/actuals.functions";
import {
  MR_CATEGORIES,
  MR_TONE_CLASS,
  buildCategorySummary,
  buildHero,
  type MRCategorySummary,
  type MRScope,
} from "@/lib/model-results";

const calibrationQ = queryOptions({
  queryKey: ["calibration"],
  queryFn: () => getCalibration(),
  staleTime: 5 * 60 * 1000,
});

const leadersQ = (date?: string) =>
  queryOptions({
    queryKey: ["mr-leaders", date ?? "today"],
    queryFn: () => getSimulationLeaders({ data: date ? { date } : {} }),
    staleTime: 60_000,
  });

const actualsQ = (date?: string) =>
  queryOptions({
    queryKey: ["mr-actuals", date ?? "today"],
    queryFn: () => getActualsForDate({ data: date ? { date } : {} }),
    staleTime: 60_000,
  });

export const Route = createFileRoute("/calibration-lab")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Model Results · Diamond" },
      {
        name: "description",
        content:
          "How Diamond's finalized simulation projections performed against actual box scores.",
      },
    ],
  }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(calibrationQ),
      context.queryClient.ensureQueryData(leadersQ(undefined)),
      context.queryClient.ensureQueryData(actualsQ(undefined)),
    ]),
  component: ModelResultsPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">
      Couldn't load Model Results: {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-8">Not found.</div>,
});

function ModelResultsPage() {
  const { data: calibration } = useSuspenseQuery(calibrationQ);
  const { data: leaders } = useSuspenseQuery(leadersQ(undefined));
  const { data: actuals } = useSuspenseQuery(actualsQ(undefined));

  const [scope, setScope] = useState<MRScope>("all");

  const summaries = useMemo(
    () => MR_CATEGORIES.map((c) => buildCategorySummary(c, leaders, actuals, scope)),
    [leaders, actuals, scope],
  );
  const hero = useMemo(() => buildHero(summaries), [summaries]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-6 space-y-10">
      <header className="space-y-1">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">
          Diamond model validation
        </div>
        <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
          Model Results
        </h1>
        <p className="text-sm text-muted-foreground">
          How Diamond's finalized simulation projections performed against actual box scores.
        </p>
        <p className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Slate: {leaders.date} · {actuals.finalGames.length} final ·{" "}
          {actuals.pendingGames.length} pending
        </p>
      </header>

      <MeanProjectionAccuracy
        summaries={summaries}
        hero={hero}
        scope={scope}
        setScope={setScope}
      />

      <ProbabilityCalibration data={calibration} />
    </div>
  );
}

/* ============================================================
 * Section A — Mean Projection Accuracy
 * ============================================================ */

function MeanProjectionAccuracy({
  summaries,
  hero,
  scope,
  setScope,
}: {
  summaries: MRCategorySummary[];
  hero: ReturnType<typeof buildHero>;
  scope: MRScope;
  setScope: (s: MRScope) => void;
}) {
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/40 pb-3">
        <div>
          <div className="mono text-[10px] uppercase tracking-widest text-edge">Section 1</div>
          <h2 className="font-display text-2xl font-bold tracking-wide">
            Mean Projection Accuracy
          </h2>
          <p className="text-xs text-muted-foreground">
            Grades existing Monte Carlo mean outputs (H.mean, TB.mean, RBI.mean, R.mean, K.mean,
            Outs.mean, BB.mean) against final box-score actuals.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border/60 bg-card/40 p-0.5">
          {(["all", "top25"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`mono rounded px-2.5 py-1 text-[10px] uppercase tracking-widest transition ${
                scope === s
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s === "all" ? "All Qualified" : "Top 25 Only"}
            </button>
          ))}
        </div>
      </div>

      {/* Hero summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <HeroCard
          label="Qualified Projections"
          value={hero.qualified.toLocaleString()}
          sub="Mean ≥ 0.5 with final actual"
          tooltip="Qualified projections have a mean of at least 0.5. A zero actual result never counts as a successful projection."
        />
        <HeroCard
          label="Met or Beat"
          value={
            <>
              {hero.metOrBeat}
              <span className="text-muted-foreground">
                {" "}/ {hero.qualified}
              </span>
            </>
          }
          sub={
            hero.metOrBeatPct == null
              ? "—"
              : `${(hero.metOrBeatPct * 100).toFixed(1)}% hit rate`
          }
          tone="good"
        />
        <HeroCard label="Close" value={hero.close} sub="actual = target − 1" tone="warn" />
        <HeroCard label="Missed" value={hero.missed} sub="incl. all zero actuals" tone="bad" />
        <HeroCard
          label="Avg Category MAE"
          value={hero.avgCategoryMAE == null ? "—" : hero.avgCategoryMAE.toFixed(2)}
          sub="Equal-weight average of category MAEs"
        />
        <HeroCard
          label="Hitters · Mean → Actual"
          value={
            hero.hitterAvgMean == null
              ? "—"
              : `${hero.hitterAvgMean.toFixed(2)} → ${hero.hitterAvgActual?.toFixed(2) ?? "—"}`
          }
          sub="Average across qualified hitter projections"
        />
        <HeroCard
          label="Pitchers · Mean → Actual"
          value={
            hero.pitcherAvgMean == null
              ? "—"
              : `${hero.pitcherAvgMean.toFixed(2)} → ${hero.pitcherAvgActual?.toFixed(2) ?? "—"}`
          }
          sub="Average across qualified pitcher projections"
        />
        <HeroCard
          label="Scope"
          value={scope === "top25" ? "Top 25" : "All Qualified"}
          sub={
            scope === "top25"
              ? "Per-category top-25 leaderboard rows only"
              : "Every player with mean ≥ 0.5 (per category)"
          }
        />
      </div>

      {hero.qualified === 0 ? (
        <div className="rounded-lg border border-border/60 bg-card/30 p-6 text-center text-sm text-muted-foreground">
          No finalized projections to grade yet. Once today's games go Final, results appear here.
        </div>
      ) : (
        <CategoryTable summaries={summaries} />
      )}
    </section>
  );
}

function HeroCard({
  label,
  value,
  sub,
  tone,
  tooltip,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "good" | "warn" | "bad";
  tooltip?: string;
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-300"
          : "text-foreground";
  return (
    <div
      className="rounded-xl border border-border/60 bg-card/60 p-4"
      title={tooltip}
    >
      <div className="mono flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
        {tooltip ? (
          <span
            aria-label={tooltip}
            className="mono inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-border/70 text-[8px] font-bold text-muted-foreground"
          >
            i
          </span>
        ) : null}
      </div>
      <div className={`font-display mt-1 text-2xl font-bold tabular-nums ${toneClass}`}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function CategoryTable({ summaries }: { summaries: MRCategorySummary[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60 bg-card/30">
      <table className="table-modern w-full text-left text-xs">
        <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <tr className="border-b border-border/40">
            <th className="px-2 py-2">Category</th>
            <th className="px-2 py-2 text-right">Qual</th>
            <th className="px-2 py-2 text-right">Met/Beat</th>
            <th className="px-2 py-2 text-right">Close</th>
            <th className="px-2 py-2 text-right">Missed</th>
            <th className="px-2 py-2 text-right">Hit Rate</th>
            <th className="px-2 py-2 text-right">Avg Mean</th>
            <th className="px-2 py-2 text-right">Avg Actual</th>
            <th className="px-2 py-2 text-right">MAE</th>
            <th className="px-2 py-2 text-right" title="avg(actual − mean). Positive = under-projection, negative = over-projection.">Bias</th>
            <th className="px-2 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {summaries.map((s) => {
            const isOpen = expanded === s.cat.key;
            return (
              <CategoryRow
                key={s.cat.key}
                s={s}
                isOpen={isOpen}
                onToggle={() => setExpanded(isOpen ? null : s.cat.key)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CategoryRow({
  s,
  isOpen,
  onToggle,
}: {
  s: MRCategorySummary;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-t border-border/30 hover:bg-card/60"
        onClick={onToggle}
      >
        <td className="px-2 py-2">
          <span className="font-semibold">{s.cat.label}</span>
          <span className="mono ml-2 text-[10px] uppercase tracking-widest text-muted-foreground">
            {s.cat.group}
          </span>
        </td>
        <td className="px-2 py-2 text-right mono tabular-nums">{s.qualified}</td>
        <td className="px-2 py-2 text-right mono tabular-nums text-emerald-300">{s.metOrBeat}</td>
        <td className="px-2 py-2 text-right mono tabular-nums text-amber-300">{s.close}</td>
        <td className="px-2 py-2 text-right mono tabular-nums text-rose-300">{s.missed}</td>
        <td className="px-2 py-2 text-right mono tabular-nums">
          {s.hitRate == null ? "—" : `${(s.hitRate * 100).toFixed(0)}%`}
        </td>
        <td className="px-2 py-2 text-right mono tabular-nums text-edge">
          {s.avgMean == null ? "—" : s.avgMean.toFixed(s.cat.meanDigits)}
        </td>
        <td className="px-2 py-2 text-right mono tabular-nums">
          {s.avgActual == null ? "—" : s.avgActual.toFixed(s.cat.meanDigits)}
        </td>
        <td className="px-2 py-2 text-right mono tabular-nums">
          {s.mae == null ? "—" : s.mae.toFixed(2)}
        </td>
        <td className={`px-2 py-2 text-right mono tabular-nums ${
          s.bias == null
            ? "text-muted-foreground"
            : s.bias >= 0
              ? "text-sky-300"
              : "text-amber-300"
        }`}>
          {s.bias == null ? "—" : `${s.bias >= 0 ? "+" : ""}${s.bias.toFixed(2)}`}
        </td>
        <td className="px-2 py-2 text-right text-muted-foreground">{isOpen ? "▾" : "▸"}</td>
      </tr>
      {isOpen ? (
        <tr>
          <td colSpan={11} className="bg-background/40 px-2 py-3">
            <PlayerBreakdown summary={s} />
          </td>
        </tr>
      ) : null}
    </>
  );
}



function PlayerBreakdown({ summary }: { summary: MRCategorySummary }) {
  if (summary.rows.length === 0 && summary.unqualifiedRows.length === 0) {
    return <div className="text-xs text-muted-foreground">No finalized rows.</div>;
  }
  return (
    <div className="space-y-3">
      {summary.rows.length > 0 ? (
        <div className="overflow-x-auto rounded border border-border/40">
          <table className="table-modern w-full text-left text-[11px]">
            <thead className="mono text-[9px] uppercase tracking-widest text-muted-foreground">
              <tr className="border-b border-border/40">
                <th className="px-2 py-1.5">Player</th>
                <th className="px-2 py-1.5">Team</th>
                <th className="px-2 py-1.5">Opp</th>
                <th className="px-2 py-1.5 text-right">Mean</th>
                <th className="px-2 py-1.5 text-right">Target</th>
                <th className="px-2 py-1.5 text-right">Actual</th>
                <th className="px-2 py-1.5">Result</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((r) => (
                <tr key={r.key} className="border-t border-border/30">
                  <td className="px-2 py-1.5">
                    {r.mlb_id ? (
                      <Link
                        to="/players/$playerId"
                        params={{ playerId: String(r.mlb_id) }}
                        className="font-semibold hover:underline"
                      >
                        {r.player_name}
                      </Link>
                    ) : (
                      <span className="font-semibold">{r.player_name}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 mono text-muted-foreground">{r.team_abbrev}</td>
                  <td className="px-2 py-1.5 mono text-muted-foreground">{r.opp_abbrev}</td>
                  <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">
                    {r.mean.toFixed(summary.cat.meanDigits)}
                  </td>
                  <td className="px-2 py-1.5 text-right mono tabular-nums text-muted-foreground">
                    {r.target}
                  </td>
                  <td className="px-2 py-1.5 text-right mono tabular-nums">{r.actual}</td>
                  <td className="px-2 py-1.5">
                    <span className={`mono inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${MR_TONE_CLASS[r.tone]}`}>
                      {r.grade}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {summary.unqualifiedRows.length > 0 ? (
        <details className="rounded border border-border/40 bg-background/30 p-2">
          <summary className="mono cursor-pointer text-[10px] uppercase tracking-widest text-muted-foreground">
            Unqualified rows (mean &lt; 0.5) · {summary.unqualifiedRows.length} · excluded from hit rate
          </summary>
          <table className="table-modern mt-2 w-full text-left text-[11px]">
            <thead className="mono text-[9px] uppercase tracking-widest text-muted-foreground">
              <tr className="border-b border-border/40">
                <th className="px-2 py-1.5">Player</th>
                <th className="px-2 py-1.5">Team</th>
                <th className="px-2 py-1.5 text-right">Mean</th>
                <th className="px-2 py-1.5 text-right">Actual</th>
                <th className="px-2 py-1.5">Note</th>
              </tr>
            </thead>
            <tbody>
              {summary.unqualifiedRows.map((r) => (
                <tr key={r.key} className="border-t border-border/30">
                  <td className="px-2 py-1.5">
                    {r.mlb_id ? (
                      <Link
                        to="/players/$playerId"
                        params={{ playerId: String(r.mlb_id) }}
                        className="hover:underline"
                      >
                        {r.player_name}
                      </Link>
                    ) : (
                      r.player_name
                    )}
                  </td>
                  <td className="px-2 py-1.5 mono text-muted-foreground">{r.team_abbrev}</td>
                  <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">
                    {r.mean.toFixed(summary.cat.meanDigits)}
                  </td>
                  <td className="px-2 py-1.5 text-right mono tabular-nums">{r.actual}</td>
                  <td className="px-2 py-1.5">
                    <span className={`mono inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${MR_TONE_CLASS[r.tone]}`}>
                      {r.grade}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Section B — Probability Calibration (existing, relabeled)
 * ============================================================ */

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

function ProbabilityCalibration({ data }: { data: { rows: CalibrationRow[]; versions: { version: string; active: boolean }[] } }) {
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
        if (s.key === "hr" && b.key === "low") {
          map[s.key][b.key] = toCell(r, { excluded: true, excludedLabel: "No HR Play" });
        } else {
          map[s.key][b.key] = toCell(r);
        }
      }
    }
    return map;
  }, [rows]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/40 pb-3">
        <div>
          <div className="mono text-[10px] uppercase tracking-widest text-edge">Section 2</div>
          <h2 className="font-display text-2xl font-bold tracking-wide">Probability Calibration</h2>
          <p className="text-xs text-muted-foreground">
            "Does a 70% model probability happen about 70% of the time over a meaningful sample?"
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Actual 0 is always a miss; actual ≥ 1 is a hit. A zero actual is never counted as a
            successful prediction.
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {STATS.map((s) => (
          <StatCard key={s.key} stat={s} buckets={grid[s.key]} />
        ))}
      </div>
    </section>
  );
}

function StatCard({ stat, buckets }: { stat: { key: StatKey; label: string; sub: string }; buckets: Record<BucketKey, Cell> }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-5">
      <div className="mb-4">
        <div className="mono text-[10px] uppercase tracking-widest text-edge">{stat.sub}</div>
        <h3 className="font-display text-lg font-semibold">{stat.label}</h3>
      </div>
      <table className="table-modern mono w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-1 py-1.5 text-left uppercase tracking-widest">Bucket</th>
            <th className="px-1 py-1.5 text-right uppercase tracking-widest">Pred</th>
            <th className="px-1 py-1.5 text-right uppercase tracking-widest">Obs</th>
            <th className="px-1 py-1.5 text-right uppercase tracking-widest">Hits</th>
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
            if (c.excluded) {
              return (
                <tr key={b.key} className="border-t border-border/40 text-muted-foreground">
                  <td className="px-1 py-2 text-left">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">{b.label}</span>
                      <span className="text-[10px] text-muted-foreground">{b.range}</span>
                    </div>
                  </td>
                  <td colSpan={6} className="px-1 py-2 text-right italic">
                    {c.excludedLabel ?? "Excluded"} · not graded
                  </td>
                </tr>
              );
            }
            const hitsCell =
              c.observedHits != null && c.sampleSize > 0
                ? `${c.observedHits} / ${c.sampleSize}`
                : "—";
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
                <td className="px-1 py-2 text-right text-foreground">{hitsCell}</td>
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
