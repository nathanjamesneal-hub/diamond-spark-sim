import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ForecastsTabBar } from "@/components/forecasts-tab-bar";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { z } from "zod";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { getPropBoardLive, type PropBoardRow, type PropBoardPayload } from "@/lib/prop-board/build.functions";
import { SUPPORTED_MARKETS, type PropMarket, MARKET_META } from "@/lib/prop-board/score";
import { ChevronDown, ChevronRight, AlertTriangle, TrendingUp, TrendingDown, Minus } from "lucide-react";

const searchSchema = z.object({
  date: z.string().optional(),
  market: fallback(z.enum(["all", ...SUPPORTED_MARKETS]), "all").default("all"),
  role: fallback(z.enum(["all", "hitter", "pitcher"]), "all").default("all"),
  tier: fallback(z.enum(["all", "heavy", "strong", "watchlist", "preview"]), "all").default("all"),
  confirmed: fallback(z.enum(["all", "confirmed"]), "all").default("all"),
  q: z.string().optional(),
});

function boardQuery(date: string | undefined) {
  return queryOptions({
    queryKey: ["prop-board-live", date ?? "today"],
    queryFn: () => getPropBoardLive({ data: date ? { date } : {} }),
    staleTime: 60_000,
    retry: 2,
  });
}

export const Route = createFileRoute("/_authenticated/top-props")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Prop Board — Diamond" },
      { name: "description", content: "Unified Diamond Prop Board — Monte Carlo probability, recent form, matchup, opportunity, and uncertainty combined into a transparent prop-quality score." },
      { property: "og:title", content: "Prop Board — Diamond" },
      { property: "og:description", content: "Ranked player-prop board built from persisted Monte Carlo distributions and Risers & Fallers signals." },
    ],
  }),
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => ({ date: search.date }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(boardQuery(deps.date)),
  component: PropBoardPage,
  errorComponent: ({ error, reset }) => {
    const router = useRouter();
    return (
      <div className="p-8 text-sm text-muted-foreground space-y-2">
        <div>Couldn't load Prop Board: {error.message}</div>
        <button onClick={() => { reset(); router.invalidate(); }} className="rounded-md border border-border/60 px-3 py-1 text-xs uppercase tracking-widest">Retry</button>
      </div>
    );
  },
  notFoundComponent: () => <div className="p-8">Nothing here.</div>,
});

function pct(p: number | null): string {
  if (p == null || !isFinite(p)) return "—";
  return `${Math.round(p * 100)}%`;
}

function tierBadge(tier: PropBoardRow["tier"]): { label: string; cls: string } {
  switch (tier) {
    case "heavy":     return { label: "Heavy",   cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };
    case "strong":    return { label: "Strong",  cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" };
    case "watchlist": return { label: "Watch",   cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" };
    case "preview":   return { label: "Preview", cls: "bg-violet-500/15 text-violet-300 border-violet-500/30" };
    default:          return { label: "Excluded", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" };
  }
}

function FormIcon({ dir }: { dir: PropBoardRow["formDirection"] }) {
  if (dir === "rising")  return <TrendingUp className="inline size-3 text-emerald-400" />;
  if (dir === "falling") return <TrendingDown className="inline size-3 text-rose-400" />;
  return <Minus className="inline size-3 text-muted-foreground" />;
}

function reasonLabel(r: string): string {
  return r.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function ModeLabel({ mode }: { mode: PropBoardRow["mode"] }) {
  return (
    <span className={`mono rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider ${
      mode === "market_compared"
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
        : "border-zinc-500/40 bg-zinc-500/10 text-zinc-400"
    }`}>
      {mode === "market_compared" ? "Market Compared" : "Model Only"}
    </span>
  );
}

function StageBadge({ stage }: { stage: string | null }) {
  if (!stage) return null;
  const map: Record<string, string> = {
    early: "border-slate-500/40 bg-slate-500/10 text-slate-300",
    updated: "border-blue-500/40 bg-blue-500/10 text-blue-300",
    lineup_confirmed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    final_pregame: "border-purple-500/40 bg-purple-500/10 text-purple-300",
  };
  return (
    <span className={`mono rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider ${map[stage] ?? "border-zinc-500/40 bg-zinc-500/10 text-zinc-400"}`}>
      {stage.replace(/_/g, " ")}
    </span>
  );
}

function BoardRow({ row, rank }: { row: PropBoardRow; rank: number }) {
  const [open, setOpen] = useState(false);
  const tb = tierBadge(row.tier);
  return (
    <>
      <tr className="border-t border-border/40 hover:bg-secondary/40">
        <td className="px-2 py-2 mono text-xs text-muted-foreground">{rank}</td>
        <td className="px-2 py-2">
          <button onClick={() => setOpen((v) => !v)} className="text-left">
            {open ? <ChevronDown className="inline size-3" /> : <ChevronRight className="inline size-3" />}
            {row.mlbId ? (
              <Link to="/players/$playerId" params={{ playerId: String(row.mlbId) }} className="ml-1 font-medium hover:underline">
                {row.playerName}
              </Link>
            ) : (
              <span className="ml-1 font-medium">{row.playerName}</span>
            )}
            {row.battingOrder ? <span className="mono ml-2 text-[10px] text-muted-foreground">#{row.battingOrder}</span> : null}
            {row.isPitcher ? <span className="mono ml-1 text-[10px] text-edge">SP</span> : null}
          </button>
        </td>
        <td className="px-2 py-2 mono text-xs">{row.teamAbbrev}</td>
        <td className="px-2 py-2 mono text-xs text-muted-foreground">{row.oppAbbrev}</td>
        <td className="px-2 py-2 mono text-xs">{row.line}</td>
        <td className="px-2 py-2 mono text-right text-xs">
          {row.projectedMean != null ? `${row.projectedMean.toFixed(2)} ${row.meanUnit}` : "—"}
        </td>
        <td className="px-2 py-2 text-right">
          <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-bold ${tb.cls}`}>{pct(row.eventProbability)}</span>
        </td>
        <td className="px-2 py-2 mono text-right text-xs">{Math.round(row.score)}</td>
        <td className="px-2 py-2 text-center"><FormIcon dir={row.formDirection} /></td>
        <td className="px-2 py-2 mono text-center text-xs">{row.matchupGrade != null ? Math.round(row.matchupGrade) : <span className="text-muted-foreground italic">n/a</span>}</td>
        <td className="px-2 py-2 mono text-center text-xs">{row.lineupStatus}</td>
        <td className="px-2 py-2 text-center"><span className={`mono rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider ${tb.cls}`}>{tb.label}</span></td>
        <td className="px-2 py-2 text-center">
          {row.reasons.length > 0 ? (
            <span title={row.reasons.map(reasonLabel).join(" · ")}>
              <AlertTriangle className={`inline size-3 ${row.excluded ? "text-rose-400" : "text-amber-400"}`} />
            </span>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr className="border-t border-border/20 bg-card/30">
          <td colSpan={13} className="px-4 py-3 text-xs">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Score components</div>
                <ul className="space-y-0.5">
                  <li>Probability: <b>{(row.components.probability * 100).toFixed(0)}%</b></li>
                  <li>Mean vs Line: <b>{(row.components.meanVsLine * 100).toFixed(0)}%</b></li>
                  <li>Opportunity: <b>{(row.components.opportunity * 100).toFixed(0)}%</b></li>
                  <li>Form: <b>{(row.components.form * 100).toFixed(0)}%</b> · sample {row.formSampleSize ?? 0}</li>
                  <li>Matchup: <b>{row.components.matchup != null ? `${(row.components.matchup * 100).toFixed(0)}%` : "unavailable"}</b></li>
                  <li>Stability: <b>{(row.components.stability * 100).toFixed(0)}%</b></li>
                </ul>
              </div>
              <div>
                <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Sim provenance</div>
                <ul className="space-y-0.5 text-muted-foreground">
                  <li>Sims: <b>{row.simCount?.toLocaleString() ?? "—"}</b></li>
                  <li>StdErr: <b>{row.stderr != null ? row.stderr.toFixed(3) : "—"}</b></li>
                  <li>Confidence: <b>{row.confidence != null ? row.confidence.toFixed(2) : "—"}</b></li>
                  <li>Stage: <StageBadge stage={row.projectionStage} /></li>
                  <li>Mode: <ModeLabel mode={row.mode} /></li>
                  <li className="truncate">Inputs: <span className="mono">{row.inputsHash?.slice(0, 8) ?? "—"}</span></li>
                  <li>Updated: {new Date(row.lastUpdated).toLocaleTimeString()}</li>
                </ul>
              </div>
              <div>
                <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Why here · what could change</div>
                {row.reasons.length === 0 ? (
                  <div className="text-muted-foreground">No warnings. Clean qualifying inputs.</div>
                ) : (
                  <ul className="space-y-0.5">
                    {row.reasons.map((r) => (
                      <li key={r} className={row.excluded && ["missing_probability","missing_mean","stale_output","newer_sim_pending","game_started","below_watchlist_probability"].includes(r) ? "text-rose-400" : "text-amber-400"}>
                        · {reasonLabel(r)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function BoardTable({ rows, emptyText }: { rows: PropBoardRow[]; emptyText: string }) {
  if (rows.length === 0) {
    return <div className="rounded-lg border border-border/60 bg-card/30 p-4 text-center text-xs text-muted-foreground">{emptyText}</div>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <thead className="bg-card/50 text-muted-foreground">
          <tr className="mono text-[10px] uppercase tracking-widest">
            <th className="px-2 py-2 text-left">#</th>
            <th className="px-2 py-2 text-left">Player</th>
            <th className="px-2 py-2 text-left">Tm</th>
            <th className="px-2 py-2 text-left">Opp</th>
            <th className="px-2 py-2 text-left">Line</th>
            <th className="px-2 py-2 text-right">Mean</th>
            <th className="px-2 py-2 text-right">Prob</th>
            <th className="px-2 py-2 text-right">Score</th>
            <th className="px-2 py-2 text-center">Form</th>
            <th className="px-2 py-2 text-center">Mtch</th>
            <th className="px-2 py-2 text-center">Lineup</th>
            <th className="px-2 py-2 text-center">Tier</th>
            <th className="px-2 py-2 text-center">!</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => <BoardRow key={r.key} row={r} rank={i + 1} />)}
        </tbody>
      </table>
    </div>
  );
}

function PropBoardPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(boardQuery(search.date));

  const setSearch = (patch: Record<string, string | undefined>) =>
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }), replace: true });

  const filteredBoards = useMemo(() => {
    const q = (search.q ?? "").trim().toLowerCase();
    return data.boards
      .filter((b) => search.market === "all" || b.market === search.market)
      .filter((b) => search.role === "all" || b.role === search.role)
      .map((b) => {
        const filterRow = (r: PropBoardRow) => {
          if (search.confirmed === "confirmed" && r.lineupStatus !== "confirmed") return false;
          if (q && !r.playerName.toLowerCase().includes(q) && !r.teamAbbrev.toLowerCase().includes(q)) return false;
          return true;
        };
        const heavy = b.heavy.filter(filterRow);
        const strong = b.strong.filter(filterRow);
        const watchlist = b.watchlist.filter(filterRow);
        const preview = b.preview.filter(filterRow);
        const excluded = b.excluded.filter(filterRow);
        return { ...b, heavy, strong, watchlist, preview, excluded };
      });
  }, [data.boards, search.market, search.role, search.confirmed, search.q]);

  return (
    <>
      <ForecastsTabBar />
      <div className="mx-auto max-w-7xl px-3 py-4 md:px-6 md:py-6 space-y-5">
        <header className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="font-display text-2xl font-bold tracking-wide">Prop Board</h1>
            <span className="mono rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-widest text-emerald-300">Live</span>
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{data.slateDate}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Unified ranking from persisted Monte Carlo distributions, Risers &amp; Fallers signals, matchup grades, and opportunity certainty.
            Probability is the strongest input. Missing matchup or sportsbook data stays honest — never replaced with fake neutral scores.
          </p>
        </header>

        {/* Best of the day */}
        <section className="space-y-2">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Best of the Day</div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7">
            {data.bestOf.map((b) => {
              const meta = MARKET_META[b.market];
              return (
                <div key={b.market} className="rounded-lg border border-border/60 bg-card/40 p-2">
                  <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{b.label}</div>
                  {b.row ? (
                    <div className="mt-1">
                      <div className="text-sm font-semibold leading-tight truncate">{b.row.playerName}</div>
                      <div className="mono text-[10px] text-muted-foreground">{b.row.teamAbbrev} vs {b.row.oppAbbrev}</div>
                      <div className={`mt-1 inline-block rounded border px-1.5 py-0.5 text-xs font-bold ${tierBadge(b.row.tier).cls}`}>
                        {pct(b.row.eventProbability)} · {meta.line}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-muted-foreground">No qualified play</div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Totals + filters */}
        <section className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/30 p-3 text-xs">
          <div className="flex flex-wrap gap-2 mono">
            <span className="text-emerald-300">Heavy {data.totals.heavy}</span>
            <span className="text-sky-300">Strong {data.totals.strong}</span>
            <span className="text-amber-300">Watch {data.totals.watchlist}</span>
            <span className="text-violet-300">Preview {data.totals.preview}</span>
            <span className="text-zinc-400">Excl {data.totals.excluded}</span>
            <span className="text-muted-foreground">of {data.totals.considered}</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select value={search.market} onChange={(e) => setSearch({ market: e.target.value })} className="rounded-md border border-border/60 bg-background px-2 py-1">
              <option value="all">All markets</option>
              {SUPPORTED_MARKETS.map((m) => <option key={m} value={m}>{MARKET_META[m].label}</option>)}
            </select>
            <select value={search.role} onChange={(e) => setSearch({ role: e.target.value })} className="rounded-md border border-border/60 bg-background px-2 py-1">
              <option value="all">Hitters + Pitchers</option>
              <option value="hitter">Hitters</option>
              <option value="pitcher">Pitchers</option>
            </select>
            <select value={search.tier} onChange={(e) => setSearch({ tier: e.target.value })} className="rounded-md border border-border/60 bg-background px-2 py-1">
              <option value="all">All tiers</option>
              <option value="heavy">Heavy only</option>
              <option value="strong">Strong+</option>
              <option value="watchlist">Watchlist+</option>
              <option value="preview">Include Preview</option>
            </select>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={search.confirmed === "confirmed"} onChange={(e) => setSearch({ confirmed: e.target.checked ? "confirmed" : "all" })} />
              Confirmed only
            </label>
            <input
              value={search.q ?? ""}
              onChange={(e) => setSearch({ q: e.target.value || undefined })}
              placeholder="Search player/team"
              className="rounded-md border border-border/60 bg-background px-2 py-1"
            />
          </div>
        </section>

        {/* Boards */}
        <div className="space-y-6">
          {filteredBoards.map((b) => {
            const showHeavy = search.tier === "all" || search.tier === "heavy" || search.tier === "strong" || search.tier === "watchlist" || search.tier === "preview";
            const showStrong = search.tier === "all" || search.tier === "strong" || search.tier === "watchlist" || search.tier === "preview";
            const showWatch = search.tier === "all" || search.tier === "watchlist" || search.tier === "preview";
            const showPreview = search.tier === "all" || search.tier === "preview";
            return (
              <section key={b.market} className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-display text-lg font-bold tracking-wide">
                    {b.label} <span className="mono text-[10px] text-muted-foreground">{b.line}</span>
                  </h2>
                  <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {b.heavy.length + b.strong.length + b.watchlist.length + b.preview.length} qualified · {b.excluded.length} excluded
                  </span>
                </div>
                {b.unavailable ? (
                  <div className="rounded-lg border border-border/60 bg-card/30 p-4 text-center text-xs text-muted-foreground">{b.unavailable}</div>
                ) : (
                  <div className="space-y-3">
                    {showHeavy && b.heavy.length > 0 && (
                      <div>
                        <div className="mono text-[10px] uppercase tracking-widest text-emerald-300 mb-1">Heavy Confidence</div>
                        <BoardTable rows={b.heavy} emptyText="No heavy plays." />
                      </div>
                    )}
                    {showStrong && b.strong.length > 0 && (
                      <div>
                        <div className="mono text-[10px] uppercase tracking-widest text-sky-300 mb-1">Strong</div>
                        <BoardTable rows={b.strong} emptyText="No strong plays." />
                      </div>
                    )}
                    {showWatch && b.watchlist.length > 0 && (
                      <div>
                        <div className="mono text-[10px] uppercase tracking-widest text-amber-300 mb-1">Watchlist</div>
                        <BoardTable rows={b.watchlist} emptyText="No watchlist plays." />
                      </div>
                    )}
                    {showPreview && b.preview.length > 0 && (
                      <div>
                        <div className="mono text-[10px] uppercase tracking-widest text-violet-300 mb-1">
                          Preview — scaffold_unvalidated engine · not promoted for grading
                        </div>
                        <BoardTable rows={b.preview} emptyText="No preview plays." />
                      </div>
                    )}
                    {b.heavy.length + b.strong.length + b.watchlist.length + b.preview.length === 0 && (
                      <div className="rounded-lg border border-border/60 bg-card/30 p-4 text-center text-xs text-muted-foreground">
                        No qualified plays match the current filters.
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
