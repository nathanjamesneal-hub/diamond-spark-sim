/**
 * Daily Results — public-facing postgame recap for the latest fully
 * finalized slate. Built strictly on locked official forecasts vs final
 * box-score actuals. Heavy diagnostic tables live on /model instead.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { getSimulationLeaders } from "@/lib/sim.functions";
import { getActualsForDate } from "@/lib/actuals.functions";
import {
  getDefaultModelResultsDate,
  getModelResultsDateStatus,
} from "@/lib/model-results.functions";
import {
  selectHRRows, summarizeHR, buildBinaryMarkets, buildBestAndMisses,
  buildFullProjectionAudit, auditRowsToCsv,
  type AuditRow, type AuditStatKey,
} from "@/lib/results-helpers";
import { MR_CATEGORIES, buildCategorySummary } from "@/lib/model-results";
import { APP_LOCALE, APP_TIMEZONE } from "@/lib/timezone";

const leadersQ = (date: string) => queryOptions({
  queryKey: ["results-leaders", date],
  queryFn: () => getSimulationLeaders({ data: { date } }),
  staleTime: 60_000,
});
const actualsQ = (date: string) => queryOptions({
  queryKey: ["results-actuals", date],
  queryFn: () => getActualsForDate({ data: { date } }),
  staleTime: 60_000,
});
const statusQ = (date: string) => queryOptions({
  queryKey: ["results-status", date],
  queryFn: () => getModelResultsDateStatus({ data: { date } }),
  staleTime: 60_000,
});

const searchSchema = z.object({
  date: fallback(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), undefined),
});

function formatLongDate(iso: string): string {
  try {
    return new Date(iso + "T12:00:00Z").toLocaleDateString(APP_LOCALE, {
      timeZone: APP_TIMEZONE,
      weekday: "long", month: "long", day: "numeric", year: "numeric",
    });
  } catch { return iso; }
}

export const Route = createFileRoute("/_authenticated/results")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Daily Results · Diamond" },
      { name: "description", content: "Yesterday in Diamond — postgame recap of locked official forecasts vs. final box scores." },
    ],
  }),
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => ({ date: search.date }),
  loader: async ({ context, deps }) => {
    // IMPORTANT: an explicit ?date= URL param ALWAYS wins over the default.
    // Do not reintroduce a fallback that overrides deps.date — that path is
    // how /results used to silently jump back to legacy dates.
    let date = deps.date;
    let reason: "trusted_terminal" | "trusted_partial" | "no_trusted_forecasts_yet" | "explicit" = "explicit";
    if (!date) {
      const def = await getDefaultModelResultsDate();
      date = def.date;
      reason = def.reason;
    }
    await Promise.all([
      context.queryClient.ensureQueryData(leadersQ(date)),
      context.queryClient.ensureQueryData(actualsQ(date)),
      context.queryClient.ensureQueryData(statusQ(date)),
    ]);
    return { date, reason };
  },
  component: ResultsPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load Results: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">Not found.</div>,
});

function ResultsPage() {
  const { date, reason } = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: leaders } = useSuspenseQuery(leadersQ(date));
  const { data: actuals } = useSuspenseQuery(actualsQ(date));
  const { data: status } = useSuspenseQuery(statusQ(date));

  const hrRows = useMemo(() => selectHRRows(leaders, actuals), [leaders, actuals]);
  const hr = useMemo(() => summarizeHR(hrRows), [hrRows]);
  const markets = useMemo(() => buildBinaryMarkets(leaders, actuals), [leaders, actuals]);
  const highlights = useMemo(() => buildBestAndMisses(leaders, actuals), [leaders, actuals]);
  const meanSummaries = useMemo(
    () => MR_CATEGORIES.map((c) => buildCategorySummary(c, leaders, actuals, "all")),
    [leaders, actuals],
  );
  const audit = useMemo(() => buildFullProjectionAudit(leaders, actuals, "final"), [leaders, actuals]);

  const goToDate = (d: string | null) => { if (d) navigate({ search: { date: d } }); };
  const goLatest = () => navigate({ search: { date: undefined } });
  const { info, prevDate, nextDate, latestFinalizedDate, latestTrustedDate } = status;

  const totalGradedOfficial = info.snapshotCoverage.locked;
  const noTrusted = totalGradedOfficial === 0;
  const hit1 = markets.find((m) => m.key === "hit");

  const banner = (() => {
    if (info.scheduled === 0) return { tone: "muted" as const, text: "No games scheduled for this date." };
    if (info.final === 0) return { tone: "warn" as const, text: `Results pending — ${info.pending} games still live or incomplete.` };
    if (info.final < info.scheduled) return { tone: "warn" as const, text: `Partial slate — ${info.final} of ${info.scheduled} games final.` };
    if (!info.hasActuals) return { tone: "warn" as const, text: "Final box scores have not been imported yet." };
    return null;
  })();

  // Model Note — single sentence built strictly from displayed metrics
  const note = (() => {
    if (totalGradedOfficial === 0 || !info.hasActuals) return null;
    const bits: string[] = [];
    if (hit1?.observed_rate != null && hit1?.predicted_avg != null && hit1.n > 0) {
      const dd = (hit1.observed_rate - hit1.predicted_avg) * 100;
      bits.push(
        `Hit 1+ predicted ${(hit1.predicted_avg * 100).toFixed(1)}% vs observed ${(hit1.observed_rate * 100).toFixed(1)}% (${dd >= 0 ? "+" : ""}${dd.toFixed(1)} pp) over ${hit1.n} forecasts`,
      );
    }
    if (hr.forecast_count > 0) {
      bits.push(`HR expected ${hr.expected_hr_total.toFixed(1)} vs actual ${hr.actual_hr_total} (${hr.delta >= 0 ? "+" : ""}${hr.delta.toFixed(1)}) over ${hr.forecast_count} calls`);
    }
    if (bits.length === 0) return null;
    return bits.join(" · ") + ".";
  })();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-6 space-y-8">
      <header className="space-y-3">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">Daily Recap</div>
        <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">Yesterday in Diamond</h1>
        <p className="text-sm text-muted-foreground">
          Postgame report of locked official forecasts vs. final box scores. For deeper model
          diagnostics, see <Link to="/model" className="underline hover:text-foreground">Model Diagnostics</Link>.
        </p>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card/40 p-2">
          <button type="button" onClick={() => goToDate(prevDate)} disabled={!prevDate}
            className="mono rounded-md border border-border/60 bg-card px-3 py-1.5 text-[11px] uppercase tracking-widest text-foreground transition hover:bg-card/80 disabled:cursor-not-allowed disabled:opacity-40">
            ← Previous day
          </button>
          <input type="date" value={date} onChange={(e) => goToDate(e.target.value || null)}
            className="mono rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs text-foreground" />
          <button type="button" onClick={() => goToDate(nextDate)} disabled={!nextDate}
            className="mono rounded-md border border-border/60 bg-card px-3 py-1.5 text-[11px] uppercase tracking-widest text-foreground transition hover:bg-card/80 disabled:cursor-not-allowed disabled:opacity-40">
            Next day →
          </button>
          <button type="button" onClick={goLatest}
            className="mono rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-[11px] uppercase tracking-widest text-primary transition hover:bg-primary/20">
            Latest Finalized
            {latestFinalizedDate ? <span className="ml-1 text-muted-foreground">· {latestFinalizedDate}</span> : null}
          </button>
        </div>

        <div className="text-sm">
          <span className="mono text-[10px] uppercase tracking-widest text-edge">Reviewing</span>
          <span className="ml-2 font-display text-lg font-semibold tracking-tight">{formatLongDate(date)}</span>
          <span className="mono ml-3 text-[11px] uppercase tracking-widest text-muted-foreground">
            {info.final} / {info.scheduled} games final · {totalGradedOfficial} locked official forecasts
          </span>
        </div>

        {banner ? (
          <div className={`rounded-md border px-3 py-2 text-xs ${
            banner.tone === "warn"
              ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
              : "border-border/60 bg-card/40 text-muted-foreground"
          }`}>{banner.text}</div>
        ) : null}
      </header>

      {noTrusted ? (
        <NoTrustedForecasts
          date={date}
          info={info}
          reason={reason}
          latestTrustedDate={latestTrustedDate}
          onJump={(d) => goToDate(d)}
          formatLongDate={formatLongDate}
        />
      ) : (
        <>
          {/* A. Daily Forecast Scorecard */}
          <Section eyebrow="A · Scorecard" title="Daily Forecast Scorecard"
            sublabel="Event Probability Accuracy">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Hit 1+ Predicted"
                value={hit1?.predicted_avg == null ? "—" : `${(hit1.predicted_avg * 100).toFixed(1)}%`}
                sub={hit1?.observed_rate == null ? "—" : `Observed ${(hit1.observed_rate * 100).toFixed(1)}%`} />
              <Stat label="Hit 1+ Delta"
                value={hit1?.delta == null ? "—" : `${hit1.delta >= 0 ? "+" : ""}${(hit1.delta * 100).toFixed(1)} pp`}
                tone={hit1?.delta != null ? (Math.abs(hit1.delta) <= 0.05 ? "good" : Math.abs(hit1.delta) <= 0.15 ? "warn" : "bad") : undefined}
                sub={`over ${hit1?.n ?? 0} forecasts`} />
              <Stat label="HR Expected → Actual"
                value={hr.forecast_count === 0 ? "—" : `${hr.expected_hr_total.toFixed(1)} → ${hr.actual_hr_total}`}
                tone={hr.forecast_count === 0 ? undefined : Math.abs(hr.delta) <= 1.5 ? "good" : Math.abs(hr.delta) <= 3 ? "warn" : "bad"}
                sub={hr.forecast_count === 0 ? "no calls" : `Δ ${hr.delta >= 0 ? "+" : ""}${hr.delta.toFixed(1)} · ${sampleLabel(hr.sample_label)}`} />
              <Stat label="Official Forecasts Graded"
                value={totalGradedOfficial.toLocaleString()}
                sub={`${info.snapshotCoverage.eligible} eligible`} />
            </div>
          </Section>

          {/* B + C: Best Reads / Biggest Misses */}
          {(highlights.best.length > 0 || highlights.worst.length > 0) ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <Section eyebrow="B · Best Reads" title="Best Reads" sublabel="Largest beats vs mean projection">
                <HighlightTable rows={highlights.best} tone="good" />
              </Section>
              <Section eyebrow="C · Biggest Misses" title="Biggest Misses" sublabel="Largest shortfalls vs mean projection">
                <HighlightTable rows={highlights.worst} tone="bad" />
              </Section>
            </div>
          ) : null}

          {/* D. Market Breakdown */}
          <Section eyebrow="D · Markets" title="Market Breakdown"
            sublabel="Per-market predicted vs observed across the slate">
            <div className="overflow-x-auto rounded-lg border border-border/60 bg-card/30">
              <table className="table-modern w-full text-left text-xs">
                <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  <tr className="border-b border-border/40">
                    <th className="px-2 py-2">Market</th>
                    <th className="px-2 py-2 text-right">N</th>
                    <th className="px-2 py-2 text-right">Predicted</th>
                    <th className="px-2 py-2 text-right">Observed</th>
                    <th className="px-2 py-2 text-right">Δpp</th>
                    <th className="px-2 py-2 text-right">Brier</th>
                    <th className="px-2 py-2 text-right">Baseline Brier</th>
                    <th className="px-2 py-2 text-right">Log Loss</th>
                    <th className="px-2 py-2">Sample</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.map((m) => (
                    <tr key={m.key} className="border-t border-border/30">
                      <td className="px-2 py-2 font-semibold">{m.label}</td>
                      <td className="px-2 py-2 text-right mono tabular-nums">{m.n}</td>
                      <td className="px-2 py-2 text-right mono tabular-nums">{m.predicted_avg == null ? "—" : `${(m.predicted_avg * 100).toFixed(1)}%`}</td>
                      <td className="px-2 py-2 text-right mono tabular-nums">{m.observed_rate == null ? "—" : `${(m.observed_rate * 100).toFixed(1)}%`}</td>
                      <td className={`px-2 py-2 text-right mono tabular-nums ${m.delta == null ? "" : Math.abs(m.delta) <= 0.05 ? "text-emerald-300" : Math.abs(m.delta) <= 0.15 ? "text-amber-300" : "text-rose-300"}`}>
                        {m.delta == null ? "—" : `${m.delta >= 0 ? "+" : ""}${(m.delta * 100).toFixed(1)}`}
                      </td>
                      <td className="px-2 py-2 text-right mono tabular-nums">{m.brier == null ? "—" : m.brier.toFixed(3)}</td>
                      <td className="px-2 py-2 text-right mono tabular-nums text-muted-foreground">{m.baseline_brier == null ? "—" : m.baseline_brier.toFixed(3)}</td>
                      <td className="px-2 py-2 text-right mono tabular-nums">{m.log_loss == null ? "—" : m.log_loss.toFixed(3)}</td>
                      <td className="px-2 py-2 text-[10px] mono uppercase tracking-widest text-muted-foreground">{sampleLabel(m.sample_label)}</td>
                    </tr>
                  ))}
                  {meanSummaries.filter((s) => s.qualified > 0).map((s) => (
                    <tr key={s.cat.key} className="border-t border-border/30">
                      <td className="px-2 py-2 font-semibold">
                        {s.cat.label}
                        <span className="mono ml-2 text-[10px] uppercase tracking-widest text-muted-foreground">mean</span>
                      </td>
                      <td className="px-2 py-2 text-right mono tabular-nums">{s.qualified}</td>
                      <td className="px-2 py-2 text-right mono tabular-nums text-edge">{s.avgMean == null ? "—" : s.avgMean.toFixed(2)}</td>
                      <td className="px-2 py-2 text-right mono tabular-nums">{s.avgActual == null ? "—" : s.avgActual.toFixed(2)}</td>
                      <td className={`px-2 py-2 text-right mono tabular-nums ${s.bias == null ? "" : s.bias >= 0 ? "text-sky-300" : "text-amber-300"}`}>
                        {s.bias == null ? "—" : `${s.bias >= 0 ? "+" : ""}${s.bias.toFixed(2)}`}
                      </td>
                      <td className="px-2 py-2 text-right mono tabular-nums" colSpan={2}>MAE {s.mae == null ? "—" : s.mae.toFixed(2)}</td>
                      <td className="px-2 py-2 text-right mono tabular-nums text-muted-foreground">—</td>
                      <td className="px-2 py-2 text-[10px] mono uppercase tracking-widest text-muted-foreground">{s.qualified < 10 ? "early" : "trusted"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* E. Full Projection Audit */}
          <FullProjectionAuditSection audit={audit} date={date} />

          {/* F. Model Note */}
          {note ? (
            <Section eyebrow="F · Note" title="Model Note">
              <p className="rounded-lg border border-border/60 bg-card/40 px-4 py-3 text-sm leading-relaxed text-foreground">{note}</p>
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}

// ── Full Projection Audit ─────────────────────────────────────────────
const HITTER_STATS: AuditStatKey[] = ["H", "TB", "HR", "RBI", "R", "SB", "K"];
const PITCHER_STATS: AuditStatKey[] = ["outs", "PK", "BB", "ER", "PH"];

function FullProjectionAuditSection({ audit, date }: { audit: ReturnType<typeof buildFullProjectionAudit>; date: string }) {
  const [tab, setTab] = useState<"hitter" | "pitcher">("hitter");
  const [query, setQuery] = useState("");
  const rows = tab === "hitter" ? audit.hitters : audit.pitchers;
  const stats = tab === "hitter" ? HITTER_STATS : PITCHER_STATS;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.player_name.toLowerCase().includes(q) ||
      r.team_abbrev.toLowerCase().includes(q) ||
      r.opp_abbrev.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const onExport = () => {
    const csv = auditRowsToCsv(filtered, stats);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diamond-audit-${tab}-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Section eyebrow="E · Audit" title="Full Projection Audit"
      sublabel="Every persisted projection vs. final box score. Read-only — no re-simulation.">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border/60 bg-card/40 p-0.5">
          {(["hitter", "pitcher"] as const).map((g) => (
            <button key={g} type="button" onClick={() => setTab(g)}
              className={`mono rounded px-3 py-1 text-[11px] uppercase tracking-widest transition ${
                tab === g ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"
              }`}>
              {g === "hitter" ? `Hitters (${audit.hitters.length})` : `Pitchers (${audit.pitchers.length})`}
            </button>
          ))}
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter player / team / opp"
          className="mono rounded-md border border-border/60 bg-card px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground" />
        <button type="button" onClick={onExport}
          className="mono rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-[10px] uppercase tracking-widest text-primary transition hover:bg-primary/20">
          Export CSV
        </button>
        <div className="mono ml-auto text-[10px] uppercase tracking-widest text-muted-foreground">
          missing actuals: {audit.missing.hitters} hitters · {audit.missing.pitchers} pitchers
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/60 bg-card/30">
        <table className="table-modern w-full text-left text-xs">
          <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <tr className="border-b border-border/40">
              <th className="px-2 py-2 sticky left-0 bg-card/60 z-10">Player</th>
              {tab === "hitter" ? <th className="px-2 py-2 text-right">Spot</th> : null}
              <th className="px-2 py-2 text-right">DS</th>
              {stats.map((k) => (
                <th key={k} className="px-2 py-2 text-right" colSpan={3}>{k}</th>
              ))}
            </tr>
            <tr className="border-b border-border/40 text-[9px]">
              <th className="px-2 py-1 sticky left-0 bg-card/60 z-10"></th>
              {tab === "hitter" ? <th></th> : null}
              <th></th>
              {stats.map((k) => (
                <Fragment key={k}>
                  <th className="px-2 py-1 text-right text-edge">μ</th>
                  <th className="px-2 py-1 text-right">act</th>
                  <th className="px-2 py-1 text-right">Δ</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={3 + stats.length * 3} className="px-2 py-4 text-center text-muted-foreground">No graded rows.</td></tr>
            ) : filtered.map((r) => (
              <tr key={r.key} className="border-t border-border/30">
                <td className="px-2 py-1.5 sticky left-0 bg-card/30 z-10">
                  {r.mlb_id ? (
                    <Link to="/players/$playerId" params={{ playerId: String(r.mlb_id) }} className="font-semibold hover:underline">{r.player_name}</Link>
                  ) : <span className="font-semibold">{r.player_name}</span>}
                  <span className="mono ml-2 text-[10px] uppercase tracking-widest text-muted-foreground">{r.team_abbrev} · {r.opp_abbrev}</span>
                </td>
                {tab === "hitter" ? <td className="px-2 py-1.5 text-right mono tabular-nums">{r.lineup_spot ?? "—"}</td> : null}
                <td className="px-2 py-1.5 text-right mono tabular-nums">{r.diamond_score?.toFixed(0) ?? "—"}</td>
                {stats.map((k) => {
                  const c = r.stats[k];
                  const dTone = c?.delta == null ? "" : c.delta > 0 ? "text-emerald-300" : c.delta < 0 ? "text-rose-300" : "text-muted-foreground";
                  const fmt = (v: number | null | undefined, d = 2) => v == null ? "—" : v.toFixed(d);
                  const dig = (k === "outs" || k === "PK" || k === "BB" || k === "ER" || k === "PH") ? 1 : 2;
                  return (
                    <Fragment key={k}>
                      <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">{fmt(c?.mean, dig)}</td>
                      <td className="px-2 py-1.5 text-right mono tabular-nums">{c?.actual ?? "—"}</td>
                      <td className={`px-2 py-1.5 text-right mono tabular-nums ${dTone}`}>{c?.delta == null ? "—" : `${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(dig)}`}</td>
                    </Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function NoTrustedForecasts({
  date,
  info,
  reason,
  latestTrustedDate,
  onJump,
  formatLongDate,
}: {
  date: string;
  info: { scheduled: number; final: number; snapshotCoverage: { eligible: number; locked: number }; actualsGameCount: number };
  reason: string;
  latestTrustedDate: string | null;
  onJump: (d: string) => void;
  formatLongDate: (iso: string) => string;
}) {
  return (
    <section className="rounded-lg border border-dashed border-border/70 bg-card/40 p-6 space-y-4">
      <div>
        <div className="mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          No trusted results
        </div>
        <h2 className="font-display mt-2 text-xl tracking-tight text-foreground">
          No trusted locked forecasts available for {formatLongDate(date)}.
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Diamond began trusted tracking after the write-once forecast lifecycle was introduced.
          Historical preview and legacy projections are intentionally excluded from official grading.
        </p>
        {reason === "no_trusted_forecasts_yet" ? (
          <p className="mt-2 text-xs text-amber-200">
            No trusted locked forecasts exist anywhere yet. New official forecasts publish once a
            game's lineup is confirmed and lock at first pitch.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <MiniCount label="Games final / scheduled" value={`${info.final} / ${info.scheduled}`} />
        <MiniCount label="Official published" value={info.snapshotCoverage.eligible.toLocaleString()} />
        <MiniCount label="Forecasts locked" value={info.snapshotCoverage.locked.toLocaleString()} />
        <MiniCount label="Games with actuals" value={info.actualsGameCount.toLocaleString()} />
      </div>

      {latestTrustedDate && latestTrustedDate !== date ? (
        <button
          type="button"
          onClick={() => onJump(latestTrustedDate)}
          className="mono inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-[11px] uppercase tracking-widest text-primary transition hover:bg-primary/20"
        >
          Jump to latest trusted date · {latestTrustedDate}
        </button>
      ) : null}
    </section>
  );
}

function MiniCount({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/60 p-3">
      <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="font-display mt-1 text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}

function sampleLabel(s: "insufficient" | "early" | "trusted"): string {
  return s === "insufficient" ? "insufficient" : s === "early" ? "early" : "trusted";
}

function Section({ eyebrow, title, sublabel, children }: { eyebrow: string; title: string; sublabel?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="border-b border-border/40 pb-3">
        <div className="mono text-[10px] uppercase tracking-widest text-edge">{eyebrow}</div>
        <h2 className="font-display text-2xl font-bold tracking-wide">{title}</h2>
        {sublabel ? <div className="mono mt-0.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{sublabel}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "good" | "warn" | "bad" }) {
  const tc = tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : tone === "bad" ? "text-rose-300" : "text-foreground";
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-4">
      <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`font-display mt-1 text-2xl font-bold tabular-nums ${tc}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

import type { HighlightRow } from "@/lib/results-helpers";

function HighlightTable({ rows, tone }: { rows: HighlightRow[]; tone: "good" | "bad" }) {
  if (rows.length === 0) return <div className="text-xs text-muted-foreground">No qualifying rows.</div>;
  const dc = tone === "good" ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60 bg-card/30">
      <table className="table-modern w-full text-left text-xs">
        <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <tr className="border-b border-border/40">
            <th className="px-2 py-2">Player</th>
            <th className="px-2 py-2">Cat</th>
            <th className="px-2 py-2 text-right">Mean</th>
            <th className="px-2 py-2 text-right">Actual</th>
            <th className="px-2 py-2 text-right">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border/30">
              <td className="px-2 py-1.5">
                {r.mlb_id ? (
                  <Link to="/players/$playerId" params={{ playerId: String(r.mlb_id) }} className="font-semibold hover:underline">{r.player_name}</Link>
                ) : <span className="font-semibold">{r.player_name}</span>}
                <span className="mono ml-2 text-[10px] uppercase tracking-widest text-muted-foreground">{r.team_abbrev} · {r.opp_abbrev}</span>
              </td>
              <td className="px-2 py-1.5 mono text-muted-foreground">{r.category}</td>
              <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">{r.mean.toFixed(2)}</td>
              <td className="px-2 py-1.5 text-right mono tabular-nums">{r.actual}</td>
              <td className={`px-2 py-1.5 text-right mono tabular-nums ${dc}`}>{r.diff >= 0 ? "+" : ""}{r.diff.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
