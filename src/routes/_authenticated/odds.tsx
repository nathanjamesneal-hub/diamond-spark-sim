/**
 * Top 25 Simulation Leaders.
 * Display-only. All values come from existing Monte Carlo outputs surfaced by
 * getSimulationLeaders — no math is performed in this file.
 */
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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
  label:
    | "Beat Projection"
    | "Met Projection"
    | "Close"
    | "Missed"
    | "No Event"
    | "Beat Low Projection"
    | "Hit Event"
    | "Pending"
    | "—";
  tone: "strong" | "good" | "warn" | "bad" | "muted";
  excludeFromAccuracy?: boolean;
};
const GRADE_CLASS: Record<Grade["tone"], string> = {
  strong: "bg-emerald-500/25 text-emerald-200 border-emerald-400/50",
  good: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  bad: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  muted: "bg-zinc-500/10 text-muted-foreground border-border/40",
};

const LOW_MEAN_TOOLTIP =
  "Low mean projections below 0.5 are treated as neutral when the event does not occur, so the model does not receive false-positive credit for predicting near-zero outcomes. An actual result of zero is never counted as a successful prediction.";

function gradeCounting(mean: number | null, actual: number | null): Grade {
  if (mean == null || actual == null) return { label: "—", tone: "muted" };
  // Zero actual never counts as success.
  if (actual === 0) {
    if (mean < 0.5) {
      return { label: "No Event", tone: "muted", excludeFromAccuracy: true };
    }
    return { label: "Missed", tone: "bad" };
  }
  if (mean < 0.5) {
    // actual > 0 with a sub-0.5 projection: noteworthy but excluded from hit-rate.
    return { label: "Beat Low Projection", tone: "good", excludeFromAccuracy: true };
  }
  const floor = Math.floor(mean);
  const ceil = Math.ceil(mean);
  if (actual >= ceil) return { label: "Beat Projection", tone: "strong" };
  if (actual >= floor) return { label: "Met Projection", tone: "good" };
  if (Math.abs(actual - floor) <= 1) return { label: "Close", tone: "warn" };
  return { label: "Missed", tone: "bad" };
}
function gradeHR(actual: number | null): Grade {
  if (actual == null) return { label: "—", tone: "muted" };
  if (actual >= 1) return { label: "Hit Event", tone: "strong" };
  return { label: "No Event", tone: "bad" };
}
function gradeSB(actual: number | null): Grade {
  if (actual == null) return { label: "—", tone: "muted" };
  if (actual >= 1) return { label: "Hit Event", tone: "strong" };
  return { label: "No Event", tone: "bad" };
}
function gradeBinary(prob: number | null, actual: boolean | null): Grade {
  if (actual == null) return { label: "—", tone: "muted" };
  if (actual) {
    if (prob != null && prob >= 0.5) return { label: "Met Projection", tone: "good" };
    return { label: "Beat Projection", tone: "strong" };
  }
  // Event did not occur — never label as a success.
  if (prob != null && prob >= 0.5) return { label: "Missed", tone: "bad" };
  return { label: "No Event", tone: "muted", excludeFromAccuracy: true };
}



const searchSchema = z.object({
  date: z.string().optional(),
  cat: fallback(
    z.enum(["all", "hit", "hr", "rbi", "runs", "tb", "sb", "bk", "pk", "outs", "qs", "win"]),
    "all",
  ).default("all"),
  team: z.string().optional(),
  lineup: fallback(z.enum(["all", "locked", "verified", "waiting"]), "all").default("all"),
  scope: fallback(z.enum(["top25", "all"]), "top25").default("top25"),
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

export const Route = createFileRoute("/_authenticated/odds")({
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
  loader: ({ context, deps }) => Promise.all([
    context.queryClient.ensureQueryData(leadersQuery(deps.date)),
    context.queryClient.ensureQueryData(actualsQuery(deps.date)),
  ]),
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
  const { data: actuals } = useSuspenseQuery(actualsQuery(search.date));

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
        <div className="ml-auto flex items-center gap-1 rounded-md border border-border/60 bg-card/40 p-0.5">
          {(["top25", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSearch({ scope: s })}
              className={`mono rounded px-2.5 py-1 text-[10px] uppercase tracking-widest transition ${
                search.scope === s
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s === "top25" ? "Top 25" : "All Qualified"}
            </button>
          ))}
        </div>
      </section>

      {visibleCats.map((cat) => (
        <CategorySection
          key={cat.key}
          cat={cat}
          payload={data}
          actuals={actuals}
          team={search.team}
          lineupFilter={search.lineup}
          explicit={search.cat === cat.key}
          scope={search.scope}
        />
      ))}
    </div>
  );
}

function CategorySection({
  cat,
  payload,
  actuals,
  team,
  lineupFilter,
  explicit,
  scope,
}: {
  cat: CatDef;
  payload: SimulationLeadersPayload;
  actuals: ActualsPayload;
  team: string | undefined;
  lineupFilter: "all" | "locked" | "verified" | "waiting";
  explicit: boolean;
  scope: "top25" | "all";
}) {
  const [visibleCount, setVisibleCount] = useState(50);
  const { rows, totalQualified } = useMemo(() => {
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
    // Defensive dedupe: one row per game + player + role per category. The
    // server is authoritative; this is a safety net against stale duplicates.
    const seen = new Set<string>();
    const deduped: typeof withMean = [];
    for (const r of withMean) {
      const id = r.mlb_id ?? `name:${r.player_name}`;
      const key = `${r.game_id}:${id}:${cat.group}:${cat.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }
    withMean.sort((a, b) => {
      const ma = cat.getStat?.(a)?.mean ?? -Infinity;
      const mb = cat.getStat?.(b)?.mean ?? -Infinity;
      if (mb !== ma) return mb - ma;
      const pa = cat.getProb?.(a) ?? -Infinity;
      const pb = cat.getProb?.(b) ?? -Infinity;
      if (pb !== pa) return pb - pa;
      return (b.diamond_score ?? -Infinity) - (a.diamond_score ?? -Infinity);
    });
    const ranked = scope === "top25" ? withMean.slice(0, 25) : withMean;
    return { rows: ranked, totalQualified: withMean.length };
  }, [cat, payload, team, lineupFilter, scope]);

  const visibleRows = scope === "all" ? rows.slice(0, visibleCount) : rows;

  if (rows.length === 0 && !explicit) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold tracking-wide">{cat.label}</h2>
        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {cat.group === "hitter" ? "Hitter" : "Pitcher"} ·{" "}
          {scope === "top25"
            ? `Top ${rows.length} of ${totalQualified} qualified`
            : `${totalQualified} qualified players`}
        </div>
      </div>


      {rows.length === 0 ? (
        <div className="rounded-lg border border-border/60 bg-card/30 p-6 text-center text-sm text-muted-foreground">
          No simulation data available for this category.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/60 bg-card/30">
          <table className="table-modern w-full text-left text-xs">
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
                <th className="px-2 text-right">Actual</th>
                <th className="px-2">
                  <span className="inline-flex items-center gap-1">
                    Result
                    <span
                      role="img"
                      aria-label="Low mean projection grading"
                      title={LOW_MEAN_TOOLTIP}
                      className="mono inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border/70 text-[9px] font-bold text-muted-foreground hover:text-foreground"
                    >
                      i
                    </span>
                  </span>
                </th>
                <th className="px-2">Lineup</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r, i) => {
                const stat = cat.getStat?.(r) ?? null;
                const prob = cat.getProb?.(r) ?? null;
                const lineupStatus =
                  cat.group === "hitter"
                    ? (r as SimLeaderHitterRow).lineup_status
                    : null;
                const gamePk = r.mlb_game_id;
                const isFinal = gamePk != null && actuals.finalGames.includes(gamePk);
                const actualRecord =
                  r.mlb_id != null
                    ? cat.group === "hitter"
                      ? actuals.hitters[String(r.mlb_id)]
                      : actuals.pitchers[String(r.mlb_id)]
                    : undefined;
                const actualNum =
                  isFinal && actualRecord && cat.getActual
                    ? cat.getActual(actualRecord) ?? null
                    : null;
                const actualBool =
                  isFinal && actualRecord && cat.getBoolActual
                    ? cat.getBoolActual(actualRecord as PitcherActual)
                    : null;
                const grade: Grade = !isFinal
                  ? { label: "Pending", tone: "muted" }
                  : cat.getBoolActual
                    ? gradeBinary(prob, actualBool)
                    : cat.key === "hr"
                      ? gradeHR(actualNum)
                      : cat.key === "sb"
                        ? gradeSB(actualNum)
                        : gradeCounting(stat?.mean ?? null, actualNum);

                const actualLabel = !isFinal
                  ? "Pending"
                  : cat.getBoolActual
                    ? actualBool == null
                      ? "—"
                      : actualBool
                        ? "Yes"
                        : "No"
                    : fmtInt(actualNum);
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
                    <td className="px-2 py-1 text-right mono tabular-nums text-foreground">{actualLabel}</td>
                    <td className="px-2 py-1">
                      <span className={`mono inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${GRADE_CLASS[grade.tone]}`}>
                        {grade.label}
                      </span>
                    </td>
                    <td className="px-2 py-1 mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {lineupStatus ? lineupStatus : badgeLabel(r.badge)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {scope === "all" && visibleRows.length < rows.length ? (
            <div className="flex items-center justify-center border-t border-border/40 bg-card/40 p-3">
              <button
                type="button"
                onClick={() => setVisibleCount((n) => n + 50)}
                className="mono rounded-md border border-border/60 px-3 py-1.5 text-[11px] uppercase tracking-widest text-foreground hover:bg-card"
              >
                Load 50 more · {visibleRows.length} / {rows.length}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
