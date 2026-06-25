/**
 * Top 25 Simulation Leaders.
 * Display-only. All values come from existing Monte Carlo outputs surfaced by
 * getSimulationLeaders — no math is performed in this file.
 */
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import {
  getSimulationLeaders,
  type SimLeaderHitterRow,
  type SimLeaderPitcherRow,
  type SimStat,
  type SimulationLeadersPayload,
} from "@/lib/sim.functions";
import {
  getActualsForDate,
  type ActualsPayload,
  type HitterActual,
  type PitcherActual,
} from "@/lib/actuals.functions";
import { SimMethodologyTooltip } from "@/components/diamond/sim-methodology-tooltip";

type HitterCat = "hit" | "hr" | "rbi" | "runs" | "tb" | "sb" | "bk";
type PitcherCat = "pk" | "outs" | "qs" | "win";
type Category = HitterCat | PitcherCat;

type CatDef = {
  key: Category;
  label: string;
  group: "hitter" | "pitcher";
  meanLabel: string;
  meanDigits: number;
  // pull a SimStat off a row (or null)
  getStat?: (row: SimLeaderHitterRow | SimLeaderPitcherRow) => SimStat | null;
  // probability extractor: returns a fraction 0–1 or null
  getProb?: (row: SimLeaderHitterRow | SimLeaderPitcherRow) => number | null;
  probLabel?: string;
  // pull actual integer result off a HitterActual / PitcherActual (or null)
  getActual?: (a: HitterActual | PitcherActual) => number | null;
  // for boolean outcomes (Win, QS) — overrides numeric grading
  getBoolActual?: (a: PitcherActual) => boolean | null;
};

const CATEGORIES: CatDef[] = [
  {
    key: "hit", label: "Hits", group: "hitter", meanLabel: "Mean H", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).H,
    getProb: (r) => preferFraction(
      (r as SimLeaderHitterRow).H?.probAtLeast1 ?? null,
      (r as SimLeaderHitterRow).card_probabilities.hit,
    ),
    probLabel: "P(1+ H)",
    getActual: (a) => (a as HitterActual).H ?? null,
  },
  {
    key: "hr", label: "Home Runs", group: "hitter", meanLabel: "Mean HR", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).HR,
    getProb: (r) => preferFraction(
      (r as SimLeaderHitterRow).HR?.probAtLeast1 ?? null,
      (r as SimLeaderHitterRow).card_probabilities.hr,
    ),
    probLabel: "P(1+ HR)",
    getActual: (a) => (a as HitterActual).HR ?? null,
  },
  {
    key: "rbi", label: "RBI", group: "hitter", meanLabel: "Mean RBI", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).RBI,
    getProb: (r) => preferFraction(
      (r as SimLeaderHitterRow).RBI?.probAtLeast1 ?? null,
      (r as SimLeaderHitterRow).card_probabilities.rbi,
    ),
    probLabel: "P(1+ RBI)",
    getActual: (a) => (a as HitterActual).RBI ?? null,
  },
  {
    key: "runs", label: "Runs", group: "hitter", meanLabel: "Mean R", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).R,
    getProb: (r) => preferFraction(
      (r as SimLeaderHitterRow).R?.probAtLeast1 ?? null,
      (r as SimLeaderHitterRow).card_probabilities.run,
    ),
    probLabel: "P(1+ R)",
    getActual: (a) => (a as HitterActual).R ?? null,
  },
  {
    key: "tb", label: "Total Bases", group: "hitter", meanLabel: "Mean TB", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).TB,
    getProb: (r) => preferFraction(
      (r as SimLeaderHitterRow).TB?.probAtLeast2 ?? null,
      (r as SimLeaderHitterRow).card_probabilities.total_base,
    ),
    probLabel: "P(2+ TB)",
    getActual: (a) => (a as HitterActual).TB ?? null,
  },
  {
    key: "sb", label: "Stolen Bases", group: "hitter", meanLabel: "Mean SB", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).SB,
    getProb: (r) => preferFraction(null, (r as SimLeaderHitterRow).card_probabilities.sb),
    probLabel: "P(1+ SB)",
    getActual: (a) => (a as HitterActual).SB ?? null,
  },
  {
    key: "bk", label: "Batter Strikeouts", group: "hitter", meanLabel: "Mean K", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).K,
    getProb: (r) => preferFraction((r as SimLeaderHitterRow).K?.probAtLeast1 ?? null, null),
    probLabel: "P(1+ K)",
    getActual: (a) => (a as HitterActual).K ?? null,
  },
  {
    key: "pk", label: "Pitcher Strikeouts", group: "pitcher", meanLabel: "Mean K", meanDigits: 1,
    getStat: (r) => (r as SimLeaderPitcherRow).K,
    // No threshold K probability is exposed by the engine yet; show — until it exists.
    getProb: (r) => preferFraction(null, (r as SimLeaderPitcherRow).extra_probabilities?.["k_over"] ?? null),
    probLabel: "P(K thr)",
    getActual: (a) => (a as PitcherActual).K ?? null,
  },
  {
    key: "outs", label: "Pitcher Outs", group: "pitcher", meanLabel: "Mean Outs", meanDigits: 1,
    getStat: (r) => (r as SimLeaderPitcherRow).outs,
    getProb: () => null,
    probLabel: "P(Outs)",
    getActual: (a) => (a as PitcherActual).outs ?? null,
  },
  {
    key: "qs", label: "Quality Start", group: "pitcher", meanLabel: "Mean Outs", meanDigits: 1,
    getStat: (r) => (r as SimLeaderPitcherRow).outs,
    getProb: (r) => preferFraction(null, (r as SimLeaderPitcherRow).quality_start_probability),
    probLabel: "P(QS)",
    getBoolActual: (a) => a.qualityStart ?? null,
  },
  {
    key: "win", label: "Pitcher Win", group: "pitcher", meanLabel: "Mean Outs", meanDigits: 1,
    getStat: (r) => (r as SimLeaderPitcherRow).outs,
    getProb: (r) => preferFraction(null, (r as SimLeaderPitcherRow).win_probability),
    probLabel: "P(W)",
    getBoolActual: (a) => a.win ?? null,
  },
];

function preferFraction(a: number | null | undefined, b: number | null | undefined): number | null {
  const pick = (v: number | null | undefined) =>
    v == null || !isFinite(v) ? null : v > 1 ? Math.min(v / 100, 1) : v < 0 ? 0 : v;
  return pick(a) ?? pick(b);
}

function fmtMean(n: number | null | undefined, digits: number): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(digits);
}
function fmtPct(p: number | null | undefined): string {
  if (p == null || !isFinite(p)) return "—";
  const v = p <= 1 ? p * 100 : p;
  return `${v.toFixed(0)}%`;
}
function fmtInt(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return Math.round(n).toString();
}

function tierClasses(p: number | null): string {
  if (p == null) return "bg-zinc-500/10 text-muted-foreground border-border/40";
  if (p >= 0.80) return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (p >= 0.65) return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  if (p >= 0.50) return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-zinc-500/15 text-zinc-300 border-zinc-500/30";
}

function badgeLabel(b: string): string {
  if (b === "official") return "Official";
  if (b === "locked") return "Locked";
  if (b === "aggregated") return "Aggregated";
  return "Projected";
}

// ----- Result grading -----
// "Pending" = game not Final, "—" = stat unavailable.
type Grade = {
  label: "Beat Projection" | "Met Projection" | "Close" | "Missed" | "Pending" | "—";
  tone: "strong" | "good" | "warn" | "bad" | "muted";
};
const GRADE_CLASS: Record<Grade["tone"], string> = {
  strong: "bg-emerald-500/25 text-emerald-200 border-emerald-400/50",
  good: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  bad: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  muted: "bg-zinc-500/10 text-muted-foreground border-border/40",
};

function gradeCounting(mean: number | null, actual: number | null): Grade {
  if (mean == null || actual == null) return { label: "—", tone: "muted" };
  const floor = Math.floor(mean);
  const ceil = Math.ceil(mean);
  if (actual >= ceil) return { label: "Beat Projection", tone: "strong" };
  if (actual >= floor) return { label: "Met Projection", tone: "good" };
  if (Math.abs(actual - floor) <= 1) return { label: "Close", tone: "warn" };
  return { label: "Missed", tone: "bad" };
}
function gradeHR(mean: number | null, actual: number | null): Grade {
  if (mean == null || actual == null) return { label: "—", tone: "muted" };
  if (actual >= 1 && (mean ?? 0) >= 0.25) return { label: "Beat Projection", tone: "strong" };
  if (actual >= 1) return { label: "Met Projection", tone: "good" };
  // never punish low-prob HR rows aggressively
  return { label: "Missed", tone: (mean ?? 0) >= 0.5 ? "bad" : "muted" };
}
function gradeBinary(prob: number | null, actual: boolean | null): Grade {
  if (actual == null) return { label: "—", tone: "muted" };
  if (actual) {
    if (prob != null && prob >= 0.5) return { label: "Met Projection", tone: "good" };
    return { label: "Beat Projection", tone: "strong" };
  }
  if (prob != null && prob >= 0.5) return { label: "Missed", tone: "bad" };
  return { label: "Met Projection", tone: "muted" };
}


const searchSchema = z.object({
  date: z.string().optional(),
  cat: fallback(
    z.enum(["all", "hit", "hr", "rbi", "runs", "tb", "sb", "bk", "pk", "outs", "qs", "win"]),
    "all",
  ).default("all"),
  team: z.string().optional(),
  lineup: fallback(z.enum(["all", "locked", "verified", "waiting"]), "all").default("all"),
});

const leadersQuery = (date: string | undefined) =>
  queryOptions({
    queryKey: ["sim-leaders", date ?? "today"],
    queryFn: () => getSimulationLeaders({ data: date ? { date } : {} }),
    staleTime: 60_000,
    retry: 1,
  });

const actualsQuery = (date: string | undefined) =>
  queryOptions({
    queryKey: ["sim-actuals", date ?? "today"],
    queryFn: () => getActualsForDate({ data: date ? { date } : {} }),
    staleTime: 60_000,
    retry: 1,
  });

export const Route = createFileRoute("/odds")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Top 25 Simulation Leaders — Diamond" },
      {
        name: "description",
        content:
          "Top 25 MLB players in every category ranked from existing Monte Carlo simulation outputs.",
      },
      { property: "og:title", content: "Top 25 Simulation Leaders — Diamond" },
      {
        property: "og:description",
        content: "Ranked from existing Monte Carlo simulation outputs.",
      },
    ],
  }),
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => ({ date: search.date }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(leadersQuery(deps.date)),
  component: SimLeadersPage,
  errorComponent: ({ error, reset }) => {
    const router = useRouter();
    return (
      <div className="p-8 text-sm text-muted-foreground space-y-2">
        <div>Couldn't load Simulation Leaders: {error.message}</div>
        <button
          onClick={() => { reset(); router.invalidate(); }}
          className="rounded-md border border-border/60 px-3 py-1 text-xs uppercase tracking-widest"
        >Retry</button>
      </div>
    );
  },
  notFoundComponent: () => <div className="p-8">Nothing here.</div>,
});

function SimLeadersPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(leadersQuery(search.date));

  const setSearch = (patch: Record<string, string | undefined>) =>
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }), replace: true });

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const r of data.hitters) if (r.team_abbrev) set.add(r.team_abbrev);
    for (const r of data.pitchers) if (r.team_abbrev) set.add(r.team_abbrev);
    return Array.from(set).sort();
  }, [data.hitters, data.pitchers]);

  const visibleCats = useMemo<CatDef[]>(() => {
    if (search.cat === "all") return CATEGORIES;
    return CATEGORIES.filter((c) => c.key === search.cat);
  }, [search.cat]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 space-y-6">
      <header className="space-y-1">
        <div className="mono text-[10px] uppercase tracking-[0.25em] text-edge">Simulation Engine</div>
        <h1 className="font-display text-2xl font-bold tracking-wide md:text-3xl">
          Top 25 Simulation Leaders
        </h1>
        <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          Ranked from existing Monte Carlo simulation outputs.
          <SimMethodologyTooltip className="ml-1" />
        </p>
        <p className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Date: {data.date} · {data.games_simulated}/{data.game_count} games simulated
          {data.warnings.length > 0 ? ` · ${data.warnings.length} warnings` : ""}
        </p>
      </header>

      {/* Filters */}
      <section className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/30 p-3">
        <div className="flex items-center gap-1">
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Category</span>
          <select
            value={search.cat}
            onChange={(e) => setSearch({ cat: e.target.value })}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
          >
            <option value="all">All</option>
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Team</span>
          <select
            value={search.team ?? ""}
            onChange={(e) => setSearch({ team: e.target.value || undefined })}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
          >
            <option value="">All teams</option>
            {teams.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Lineup</span>
          <select
            value={search.lineup}
            onChange={(e) => setSearch({ lineup: e.target.value })}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
          >
            <option value="all">All</option>
            <option value="locked">Locked</option>
            <option value="verified">Verified</option>
            <option value="waiting">Waiting</option>
          </select>
        </div>
      </section>

      {visibleCats.map((cat) => (
        <CategorySection
          key={cat.key}
          cat={cat}
          payload={data}
          team={search.team}
          lineupFilter={search.lineup}
          explicit={search.cat === cat.key}
        />
      ))}
    </div>
  );
}

function CategorySection({
  cat,
  payload,
  team,
  lineupFilter,
  explicit,
}: {
  cat: CatDef;
  payload: SimulationLeadersPayload;
  team: string | undefined;
  lineupFilter: "all" | "locked" | "verified" | "waiting";
  explicit: boolean;
}) {
  const rows = useMemo(() => {
    const source: (SimLeaderHitterRow | SimLeaderPitcherRow)[] =
      cat.group === "hitter" ? payload.hitters : payload.pitchers;
    let filtered = source.filter((r) => (team ? r.team_abbrev === team : true));
    if (cat.group === "hitter" && lineupFilter !== "all") {
      filtered = filtered.filter((r) => (r as SimLeaderHitterRow).lineup_status === lineupFilter);
    }
    // Need a real mean for this category to rank.
    const withMean = filtered.filter((r) => {
      const stat = cat.getStat?.(r);
      return stat?.mean != null;
    });
    withMean.sort((a, b) => {
      const ma = cat.getStat?.(a)?.mean ?? -Infinity;
      const mb = cat.getStat?.(b)?.mean ?? -Infinity;
      if (mb !== ma) return mb - ma;
      const pa = cat.getProb?.(a) ?? -Infinity;
      const pb = cat.getProb?.(b) ?? -Infinity;
      if (pb !== pa) return pb - pa;
      return (b.diamond_score ?? -Infinity) - (a.diamond_score ?? -Infinity);
    });
    return withMean.slice(0, 25);
  }, [cat, payload, team, lineupFilter]);

  if (rows.length === 0 && !explicit) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold tracking-wide">{cat.label}</h2>
        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {cat.group === "hitter" ? "Hitter" : "Pitcher"} · Top {rows.length}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border/60 bg-card/30 p-6 text-center text-sm text-muted-foreground">
          No simulation data available for this category.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/60 bg-card/30">
          <table className="w-full text-left text-xs">
            <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr className="border-b border-border/40">
                <th className="px-2 py-2 text-right">#</th>
                <th className="px-2">Player</th>
                <th className="px-2">Team</th>
                <th className="px-2">Opp</th>
                <th className="px-2 text-right">
                  <span className="inline-flex items-center gap-1">
                    {cat.meanLabel}
                    <SimMethodologyTooltip />
                  </span>
                </th>
                <th className="px-2 text-right">
                  <span className="inline-flex items-center gap-1">
                    Sim Prob
                    <SimMethodologyTooltip />
                  </span>
                </th>
                <th className="px-2 text-right">DS</th>
                <th className="px-2 text-right">Conf</th>
                <th className="px-2">Lineup</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const stat = cat.getStat?.(r) ?? null;
                const prob = cat.getProb?.(r) ?? null;
                const lineupStatus =
                  cat.group === "hitter"
                    ? (r as SimLeaderHitterRow).lineup_status
                    : null;
                return (
                  <tr key={`${cat.key}:${r.mlb_id ?? r.player_name}:${r.game_id}`} className="border-t border-border/30">
                    <td className="px-2 py-1 text-right mono tabular-nums text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1">
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
                    <td className="px-2 py-1 mono text-muted-foreground">{r.team_abbrev}</td>
                    <td className="px-2 py-1 mono text-muted-foreground">{r.opp_abbrev}</td>
                    <td className="px-2 py-1 text-right mono tabular-nums text-edge">
                      {fmtMean(stat?.mean ?? null, cat.meanDigits)}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <span className={`mono inline-block rounded border px-1.5 py-0.5 tabular-nums ${tierClasses(prob)}`}>
                        {fmtPct(prob)}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right mono tabular-nums">{fmtInt(r.diamond_score)}</td>
                    <td className="px-2 py-1 text-right mono tabular-nums text-muted-foreground">{fmtInt(r.confidence)}</td>
                    <td className="px-2 py-1 mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {lineupStatus ? lineupStatus : badgeLabel(r.badge)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
