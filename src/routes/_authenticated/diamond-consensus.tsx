/**
 * Diamond Consensus — display-only board.
 *
 * Reuses values surfaced by getSimulationLeaders. Computes percentile ranks
 * WITHIN each category + slate and a 40/30/20/10 weighted consensus score.
 *
 * No engine math, no projection writes, no probability synthesis.
 */
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ForecastsTabBar } from "@/components/forecasts-tab-bar";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  getSimulationLeaders,
  type SimLeaderHitterRow,
  type SimLeaderPitcherRow,
  type SimStat,
  type SimulationLeadersPayload,
} from "@/lib/sim.functions";
import { getActualsForDate, type ActualsPayload, type HitterActual, type PitcherActual } from "@/lib/actuals.functions";
import {
  categoryPercentile,
  consensusScore,
  alignmentLabel,
  alignmentTone,
  confidenceFactor,
  lineupFactor,
  type AlignmentLabel,
  type LineupStatus,
} from "@/lib/consensus";
import { classifyCountProjection } from "@/lib/grading/count-projection";

type Group = "hitter" | "pitcher";
type CatKey =
  | "hit" | "hr" | "rbi" | "runs" | "tb" | "sb"
  | "pk" | "outs" | "qs" | "win";

type CatDef = {
  key: CatKey;
  label: string;
  group: Group;
  meanDigits: number;
  meanLabel: string;
  probLabel: string;
  getStat: (r: SimLeaderHitterRow | SimLeaderPitcherRow) => SimStat | null;
  getProb: (r: SimLeaderHitterRow | SimLeaderPitcherRow) => number | null;
};

function preferFraction(a: number | null | undefined, b: number | null | undefined): number | null {
  const pick = (v: number | null | undefined) =>
    v == null || !isFinite(v) ? null : v > 1 ? Math.min(v / 100, 1) : v < 0 ? 0 : v;
  return pick(a) ?? pick(b);
}

const CATEGORIES: CatDef[] = [
  { key: "hit",  label: "Hits", group: "hitter", meanDigits: 2, meanLabel: "Mean H",   probLabel: "P(1+ H)",
    getStat: (r) => (r as SimLeaderHitterRow).H,
    getProb: (r) => preferFraction((r as SimLeaderHitterRow).H?.probAtLeast1, (r as SimLeaderHitterRow).card_probabilities.hit) },
  { key: "hr",   label: "Home Runs", group: "hitter", meanDigits: 2, meanLabel: "Mean HR",  probLabel: "P(1+ HR)",
    getStat: (r) => (r as SimLeaderHitterRow).HR,
    getProb: (r) => preferFraction((r as SimLeaderHitterRow).HR?.probAtLeast1, (r as SimLeaderHitterRow).card_probabilities.hr) },
  { key: "rbi",  label: "RBI", group: "hitter", meanDigits: 2, meanLabel: "Mean RBI", probLabel: "P(1+ RBI)",
    getStat: (r) => (r as SimLeaderHitterRow).RBI,
    getProb: (r) => preferFraction((r as SimLeaderHitterRow).RBI?.probAtLeast1, (r as SimLeaderHitterRow).card_probabilities.rbi) },
  { key: "runs", label: "Runs", group: "hitter", meanDigits: 2, meanLabel: "Mean R",   probLabel: "P(1+ R)",
    getStat: (r) => (r as SimLeaderHitterRow).R,
    getProb: (r) => preferFraction((r as SimLeaderHitterRow).R?.probAtLeast1, (r as SimLeaderHitterRow).card_probabilities.run) },
  { key: "tb",   label: "Total Bases", group: "hitter", meanDigits: 2, meanLabel: "Mean TB",  probLabel: "P(2+ TB)",
    getStat: (r) => (r as SimLeaderHitterRow).TB,
    getProb: (r) => preferFraction((r as SimLeaderHitterRow).TB?.probAtLeast2, (r as SimLeaderHitterRow).card_probabilities.total_base) },
  { key: "sb",   label: "Stolen Bases", group: "hitter", meanDigits: 2, meanLabel: "Mean SB",  probLabel: "P(1+ SB)",
    getStat: (r) => (r as SimLeaderHitterRow).SB,
    getProb: (r) => preferFraction(null, (r as SimLeaderHitterRow).card_probabilities.sb) },
  { key: "pk",   label: "Pitcher Ks", group: "pitcher", meanDigits: 1, meanLabel: "Mean K",   probLabel: "—",
    getStat: (r) => (r as SimLeaderPitcherRow).K,
    getProb: () => null },
  { key: "outs", label: "Pitcher Outs", group: "pitcher", meanDigits: 1, meanLabel: "Mean Outs", probLabel: "—",
    getStat: (r) => (r as SimLeaderPitcherRow).outs,
    getProb: () => null },
  { key: "qs",   label: "Quality Start", group: "pitcher", meanDigits: 1, meanLabel: "Mean Outs", probLabel: "P(QS)",
    getStat: (r) => (r as SimLeaderPitcherRow).outs,
    getProb: (r) => preferFraction(null, (r as SimLeaderPitcherRow).quality_start_probability) },
  { key: "win",  label: "Pitcher Win", group: "pitcher", meanDigits: 1, meanLabel: "Mean Outs", probLabel: "P(W)",
    getStat: (r) => (r as SimLeaderPitcherRow).outs,
    getProb: (r) => preferFraction(null, (r as SimLeaderPitcherRow).win_probability) },
];

type ConsensusRow = {
  key: string;
  catKey: CatKey;
  catLabel: string;
  group: Group;
  meanDigits: number;
  meanLabel: string;
  probLabel: string;
  player_name: string;
  mlb_id: number | null;
  team_abbrev: string;
  opp_abbrev: string;
  game_id: string;
  gamePk: number | null;
  lineupStatus: LineupStatus;
  badge: string;
  simMean: number | null;
  simProb: number | null;
  diamondScore: number | null;
  confidence: number | null;
  dsPct: number | null;
  meanPct: number | null;
  probPct: number | null;
  confidence01: number;
  consensus: number;
  weights: { ds: number; mean: number; prob: number; confidence: number };
  contributions: { ds: number; mean: number; prob: number; confidence: number };
  probAvailable: boolean;
  alignment: AlignmentLabel;
  // Lifecycle (frozen from selected pregame snapshot)
  projection_class: "official" | "preview";
  forecast_status: SimLeaderHitterRow["forecast_status"];
  game_display_state: SimLeaderHitterRow["game_display_state"];
  forecast_run_id: string | null;
  forecast_locked_at: string | null;
};

function leadersQuery(date: string | undefined) {
  return queryOptions({
    queryKey: ["sim-leaders", date ?? null],
    queryFn: () => getSimulationLeaders({ data: date ? { date } : {} }),
  });
}

function actualsQuery(date: string | undefined) {
  return queryOptions({
    queryKey: ["sim-actuals", date ?? "today"],
    queryFn: () => getActualsForDate({ data: date ? { date } : {} }),
    staleTime: 30_000,
    refetchInterval: 45_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

export const Route = createFileRoute("/_authenticated/diamond-consensus")({
  beforeLoad: () => {
    throw redirect({ to: "/forecasts/consensus" });
  },
  component: () => null,
});

function _UnusedRoute() {
  return {
    loader: ({ context }: any) => context.queryClient.ensureQueryData(leadersQuery(undefined)),
    component: DiamondConsensusPage,
  };
}
export { DiamondConsensusPage };


function buildRows(payload: SimulationLeadersPayload): ConsensusRow[] {
  const seen = new Set<string>();
  const all: ConsensusRow[] = [];

  for (const cat of CATEGORIES) {
    const source: ReadonlyArray<SimLeaderHitterRow | SimLeaderPitcherRow> =
      cat.group === "hitter" ? payload.hitters : payload.pitchers;

    // Build population vectors for percentiles within this category + slate.
    const means: (number | null)[] = [];
    const probs: (number | null)[] = [];
    const dss: (number | null)[] = [];
    const eligible: { row: SimLeaderHitterRow | SimLeaderPitcherRow; mean: number | null; prob: number | null; ds: number | null }[] = [];

    // Per-category pregame-eligibility gate. Prevents probability-only rows
    // (e.g. an active preview projection with hit_probability but no
    // persisted sim_snapshot/H.mean) from polluting the leaderboard.
    // Rules:
    //   - Mean-bearing categories (every hitter cat + pitcher pk/outs):
    //       require finite, positive Sim Mean from the SAME selected snapshot.
    //   - Probability-bearing categories (hitter cats + qs/win):
    //       also require finite Sim Probability.
    const requireMean: Record<CatKey, boolean> = {
      hit: true, hr: true, rbi: true, runs: true, tb: true, sb: true,
      pk: true, outs: true,
      qs: true, win: true, // pitcher must have a real snapshot too
    };
    const requireProb: Record<CatKey, boolean> = {
      hit: true, hr: true, rbi: true, runs: true, tb: true, sb: true,
      pk: false, outs: false,
      qs: true, win: true,
    };

    for (const r of source) {
      const stat = cat.getStat(r);
      const mean = stat?.mean ?? null;
      const prob = cat.getProb(r);
      const ds = r.diamond_score ?? null;
      if (requireMean[cat.key] && !(mean != null && isFinite(mean) && mean > 0)) continue;
      if (requireProb[cat.key] && !(prob != null && isFinite(prob))) continue;
      eligible.push({ row: r, mean, prob, ds });
      means.push(mean);
      probs.push(prob);
      dss.push(ds);
    }

    for (const e of eligible) {
      const r = e.row;
      const role: "hitter" | "pitcher" = cat.group;
      const dedupeKey = `${r.mlb_game_id ?? r.game_id}:${r.mlb_id ?? r.player_name}:${cat.key}:${role}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const lineupStatus: LineupStatus =
        cat.group === "hitter" ? (r as SimLeaderHitterRow).lineup_status : (r as SimLeaderPitcherRow).lineup_status;

      const dsPct = categoryPercentile(dss, e.ds);
      const meanPct = categoryPercentile(means, e.mean);
      const probPct = e.prob == null ? null : categoryPercentile(probs, e.prob);

      // confidence component: blend engine confidence with lineup factor
      const lf = lineupFactor(lineupStatus);
      const cf = confidenceFactor(r.confidence);
      const conf01 = Math.max(0, Math.min(1, 0.6 * cf + 0.4 * lf));

      const score = consensusScore({ dsPct, meanPct, probPct, confidence01: conf01 });
      if (!score) continue;

      all.push({
        key: dedupeKey,
        catKey: cat.key,
        catLabel: cat.label,
        group: cat.group,
        meanDigits: cat.meanDigits,
        meanLabel: cat.meanLabel,
        probLabel: cat.probLabel,
        player_name: r.player_name,
        mlb_id: r.mlb_id,
        team_abbrev: r.team_abbrev,
        opp_abbrev: r.opp_abbrev,
        game_id: r.game_id,
        gamePk: r.mlb_game_id,
        lineupStatus,
        badge: r.badge,
        simMean: e.mean,
        simProb: e.prob,
        diamondScore: e.ds,
        confidence: r.confidence,
        dsPct,
        meanPct,
        probPct,
        confidence01: conf01,
        consensus: score.consensusScore,
        weights: score.weights,
        contributions: score.contributions,
        probAvailable: score.probAvailable,
        alignment: alignmentLabel({ dsPct, meanPct, probPct, lineupStatus }),
        projection_class: r.projection_class,
        forecast_status: r.forecast_status,
        game_display_state: r.game_display_state,
        forecast_run_id: r.forecast_run_id,
        forecast_locked_at: r.forecast_locked_at,
      });
    }
  }

  return all;
}

function fmtMean(n: number | null, digits: number) {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(digits);
}
function fmtPct(p: number | null) {
  if (p == null || !isFinite(p)) return "—";
  const v = p <= 1 ? p * 100 : p;
  return `${v.toFixed(0)}%`;
}
function fmtPctile(p: number | null) {
  if (p == null) return "—";
  return `${Math.round(p)}`;
}
function fmtInt(n: number | null) {
  if (n == null || !isFinite(n)) return "—";
  return Math.round(n).toString();
}

const ALIGN_CLASS: Record<ReturnType<typeof alignmentTone>, string> = {
  strong: "bg-emerald-500/25 text-emerald-200 border-emerald-400/50",
  good:   "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  warn:   "bg-amber-500/15 text-amber-300 border-amber-500/30",
  muted:  "bg-zinc-500/10 text-muted-foreground border-border/40",
};

function consensusTone(score: number) {
  if (score >= 80) return "strong";
  if (score >= 65) return "good";
  if (score >= 50) return "warn";
  return "muted";
}

type ScopeMode = "balanced" | "top25" | "high-prob" | "all";
type ViewMode = "pregame" | "live" | "final";

/** Per-category market definition used by the Live Consensus Tracker.
 *  Display-only. Reads frozen pregame Sim Mean / Prob already on the row,
 *  plus actuals from getActualsForDate. Never alters rank/order. */
type MarketKind = "count_threshold" | "count_raw_mean" | "binary_event";
type MarketDef = {
  unit: string;
  threshold: number | null; // for count_threshold only
  kind: MarketKind;
  actualCount: (h?: HitterActual, p?: PitcherActual) => number | null;
  /** For binary_event markets only. */
  actualBinary?: (h?: HitterActual, p?: PitcherActual) => boolean | null;
};

const MARKETS: Record<CatKey, MarketDef> = {
  hit:  { unit: "H",    threshold: 1, kind: "count_threshold", actualCount: (h) => h?.H ?? null },
  hr:   { unit: "HR",   threshold: 1, kind: "count_threshold", actualCount: (h) => h?.HR ?? null },
  rbi:  { unit: "RBI",  threshold: 1, kind: "count_threshold", actualCount: (h) => h?.RBI ?? null },
  runs: { unit: "R",    threshold: 1, kind: "count_threshold", actualCount: (h) => h?.R ?? null },
  tb:   { unit: "TB",   threshold: 2, kind: "count_threshold", actualCount: (h) => h?.TB ?? null },
  sb:   { unit: "SB",   threshold: 1, kind: "count_threshold", actualCount: (h) => h?.SB ?? null },
  pk:   { unit: "K",    threshold: null, kind: "count_raw_mean", actualCount: (_h, p) => p?.K ?? null },
  outs: { unit: "outs", threshold: null, kind: "count_raw_mean", actualCount: (_h, p) => p?.outs ?? null },
  qs:   { unit: "QS",   threshold: null, kind: "binary_event",
          actualCount: (_h, p) => p?.outs ?? null,
          actualBinary: (_h, p) => (p == null ? null : p.qualityStart) },
  win:  { unit: "W",    threshold: null, kind: "binary_event",
          actualCount: (_h, p) => null,
          actualBinary: (_h, p) => (p == null ? null : p.win) },
};

type LiveStatus = "Pending" | "In Play" | "Met" | "Behind" | "Missed" | "N/A" | "Final";

function deriveLiveOverlay(args: {
  row: ConsensusRow;
  hitterActual?: HitterActual;
  pitcherActual?: PitcherActual;
  gameState: "upcoming" | "live" | "final" | "other";
}) {
  const market = MARKETS[args.row.catKey];
  const meanCls = classifyCountProjection({
    rawMean: args.row.simMean,
    hasPersistedMetric: args.row.simMean != null,
  });
  // N/A guard: missing/non-positive mean → never grade.
  if (market.kind !== "binary_event" && meanCls.excludeFromAccuracy) {
    return {
      market,
      actual: null as number | null,
      actualBinary: null as boolean | null,
      threshold: market.threshold,
      progress: null as string | null,
      status: "N/A" as LiveStatus,
      final: args.gameState === "final" ? ("N/A" as LiveStatus) : null,
      tooltip: "No meaningful persisted pregame projection for this market",
    };
  }
  const actualCount = market.actualCount(args.hitterActual, args.pitcherActual);
  const actualBinary = market.actualBinary ? market.actualBinary(args.hitterActual, args.pitcherActual) : null;

  let status: LiveStatus = "Pending";
  let finalResult: LiveStatus | null = null;

  if (args.gameState === "upcoming") {
    status = "Pending";
  } else if (market.kind === "count_threshold" && market.threshold != null) {
    if (actualCount == null) status = args.gameState === "final" ? "Missed" : "In Play";
    else if (actualCount >= market.threshold) status = "Met";
    else status = args.gameState === "final" ? "Missed" : "Behind";
    if (args.gameState === "final") finalResult = status;
  } else if (market.kind === "binary_event") {
    if (actualBinary == null) status = args.gameState === "final" ? "Missed" : "In Play";
    else status = actualBinary ? "Met" : args.gameState === "final" ? "Missed" : "Behind";
    if (args.gameState === "final") finalResult = status;
  } else {
    // count_raw_mean — no threshold; just show actual vs mean.
    status = args.gameState === "final" ? "Final" : "In Play";
    if (args.gameState === "final") finalResult = "Final";
  }

  // Progress string per market.
  let progress: string | null = null;
  const a = actualCount;
  if (market.kind === "count_threshold" && market.threshold != null) {
    progress = `${a ?? 0} ${market.unit} / target ${market.threshold}`;
  } else if (market.kind === "binary_event") {
    if (args.row.catKey === "qs") {
      progress = `${a ?? 0} outs · ${actualBinary == null ? "—" : actualBinary ? "QS ✓" : "no QS"}`;
    } else {
      progress = actualBinary == null ? "—" : actualBinary ? "Win ✓" : "no decision";
    }
  } else {
    // raw mean
    const meanStr = args.row.simMean != null ? args.row.simMean.toFixed(args.row.meanDigits) : "—";
    const delta = a != null && args.row.simMean != null ? a - args.row.simMean : null;
    const deltaStr = delta == null ? "" : ` · ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`;
    progress = `${a ?? "—"} ${market.unit} / Sim Mean ${meanStr}${deltaStr}`;
  }

  return {
    market,
    actual: actualCount,
    actualBinary,
    threshold: market.threshold,
    progress,
    status,
    final: finalResult,
    tooltip: null,
  };
}

function statusTone(s: LiveStatus): "strong" | "good" | "warn" | "muted" {
  if (s === "Met") return "strong";
  if (s === "In Play" || s === "Behind") return "warn";
  if (s === "Missed" || s === "N/A") return "muted";
  return "muted";
}


function DiamondConsensusPage() {
  // Date selector — defaults to today (slate the leaders function picks).
  const [date, setDate] = useState<string | undefined>(undefined);
  const [view, setView] = useState<ViewMode>("pregame");

  const { data: payload } = useSuspenseQuery(leadersQuery(date));
  const { data: actuals } = useSuspenseQuery(actualsQuery(date ?? payload.date));

  const rows = useMemo(() => buildRows(payload), [payload]);

  // FROZEN pregame overall + per-category ranks. Computed once from the full
  // row set sorted by Consensus desc. Never updated by live actuals.
  const frozenRank = useMemo(() => {
    const overall = new Map<string, number>();
    const perCat = new Map<string, number>();
    const sortedAll = [...rows].sort((a, b) => b.consensus - a.consensus);
    sortedAll.forEach((r, i) => overall.set(r.key, i + 1));
    const byCat = new Map<CatKey, ConsensusRow[]>();
    for (const r of sortedAll) {
      const arr = byCat.get(r.catKey) ?? [];
      arr.push(r);
      byCat.set(r.catKey, arr);
    }
    for (const [, arr] of byCat) arr.forEach((r, i) => perCat.set(r.key, i + 1));
    return { overall, perCat };
  }, [rows]);

  // Filter UI state
  const [category, setCategory] = useState<CatKey | "all">("all");
  const [team, setTeam] = useState<string>("all");
  const [lineup, setLineup] = useState<"all" | "locked" | "verified" | "waiting">("all");
  const [scope, setScope] = useState<ScopeMode>("balanced");
  const [minProbOn, setMinProbOn] = useState<boolean>(false);
  const [minProbPct, setMinProbPct] = useState<number>(20);
  const [expanded, setExpanded] = useState<string | null>(null);
  type LiveSort = "rank" | "status" | "actual" | "delta";
  const [liveSort, setLiveSort] = useState<LiveSort>("rank");


  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.team_abbrev) set.add(r.team_abbrev);
    }
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const threshold = minProbOn ? minProbPct / 100 : null;
    return rows.filter((r) => {
      if (category !== "all" && r.catKey !== category) return false;
      if (team !== "all" && r.team_abbrev !== team) return false;
      if (lineup !== "all" && r.lineupStatus !== lineup) return false;
      if (threshold != null) {
        if (r.simProb == null || r.simProb < threshold) return false;
      }
      return true;
    });
  }, [rows, category, team, lineup, minProbOn, minProbPct]);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => b.consensus - a.consensus),
    [filtered],
  );

  const display = useMemo(() => {
    if (scope === "top25") return sorted.slice(0, 25);
    if (scope === "high-prob") {
      // Show only rows with real existing threshold probabilities,
      // ranked by raw Sim Probability descending. No DS-based ranking.
      return filtered
        .filter((r) => r.probAvailable && r.simProb != null)
        .sort((a, b) => (b.simProb ?? 0) - (a.simProb ?? 0));
    }
    if (scope === "balanced") {
      // top 4 per category, then resort by consensus
      const byCat = new Map<CatKey, ConsensusRow[]>();
      for (const r of sorted) {
        const arr = byCat.get(r.catKey) ?? [];
        if (arr.length < 4) {
          arr.push(r);
          byCat.set(r.catKey, arr);
        }
      }
      return Array.from(byCat.values()).flat().sort((a, b) => b.consensus - a.consensus);
    }
    return sorted;
  }, [sorted, filtered, scope]);

  const scopeBlurb =
    scope === "high-prob"
      ? "Most likely event outcomes across the slate, ranked by raw existing Sim Probability. Categories without real threshold probabilities are excluded. Diamond Score does not influence rank here."
      : scope === "top25"
      ? "Highest within-category agreement across the slate. HR-heavy by nature — see framing note above."
      : scope === "balanced"
      ? "Strongest 3–5 qualifying signals per available category, then sorted by Consensus Score."
      : "Every qualifying row, sorted by Consensus Score.";

  return (
    <>
      <ForecastsTabBar />
    <section className="space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="font-display text-3xl uppercase tracking-wide text-foreground">
          Diamond Consensus
        </h1>
        <p className="text-sm text-muted-foreground">
          Where Diamond Score, Sim Mean, probability, and confidence agree within a category. Display-only — not a "most likely to happen" ranking.
        </p>
        <p className="mono text-[11px] uppercase tracking-widest text-amber-300/90">
          Category-relative consensus, not absolute event likelihood.
        </p>
        <p className="text-xs text-muted-foreground">
          Date: <span className="mono text-foreground">{payload.date}</span> ·
          {" "}Games: <span className="mono text-foreground">{payload.game_count}</span> ·
          {" "}Qualified rows: <span className="mono text-foreground">{filtered.length}</span>
        </p>
        <p className="text-[11px] text-muted-foreground">{scopeBlurb}</p>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
        <Filter label="Mode">
          <Pill on={view === "pregame"} onClick={() => setView("pregame")}>Pregame Consensus</Pill>
          <Pill on={view === "live"} onClick={() => setView("live")}>Live Consensus Tracker</Pill>
          <Pill on={view === "final"} onClick={() => setView("final")}>Final Consensus Results</Pill>
        </Filter>
        <Filter label="Date">
          <input
            type="date"
            value={date ?? payload.date}
            onChange={(e) => setDate(e.target.value || undefined)}
            className="mono rounded border border-border/60 bg-background px-2 py-1 text-xs"
          />
          {date && (
            <button
              type="button"
              onClick={() => setDate(undefined)}
              className="mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
            >
              Today
            </button>
          )}
        </Filter>
        <p className="mono ml-auto text-[10px] uppercase tracking-widest text-amber-300/90">
          Live status only — rankings are frozen from pregame.
        </p>
      </div>

      {view !== "pregame" && (
        <LiveTrackerSection
          rows={rows}
          frozenRank={frozenRank}
          actuals={actuals}
          view={view}
          liveSort={liveSort}
          setLiveSort={setLiveSort}
        />
      )}

      {view === "pregame" && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card/40 p-3">

        <Filter label="View">
          <Pill on={scope === "balanced"} onClick={() => setScope("balanced")}>Balanced Board</Pill>
          <Pill on={scope === "top25"} onClick={() => setScope("top25")}>Top 25 Overall Agreement</Pill>
          <Pill on={scope === "high-prob"} onClick={() => setScope("high-prob")}>High-Probability Outcomes</Pill>
          <Pill on={scope === "all"} onClick={() => setScope("all")}>All Qualified</Pill>
        </Filter>
        <Filter label="Category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as CatKey | "all")}
            className="mono rounded border border-border/60 bg-background px-2 py-1 text-xs"
          >
            <option value="all">All</option>
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </Filter>
        <Filter label="Team">
          <select
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className="mono rounded border border-border/60 bg-background px-2 py-1 text-xs"
          >
            <option value="all">All</option>
            {teams.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Filter>
        <Filter label="Lineup">
          <select
            value={lineup}
            onChange={(e) => setLineup(e.target.value as typeof lineup)}
            className="mono rounded border border-border/60 bg-background px-2 py-1 text-xs"
          >
            <option value="all">All</option>
            <option value="locked">Locked</option>
            <option value="verified">Verified</option>
            <option value="waiting">Waiting</option>
          </select>
        </Filter>
        <Filter label="Min Prob">
          <label className="mono flex items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={minProbOn}
              onChange={(e) => setMinProbOn(e.target.checked)}
            />
            <span>{minProbOn ? "On" : "Off"}</span>
          </label>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            disabled={!minProbOn}
            value={minProbPct}
            onChange={(e) => setMinProbPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
            className="mono w-14 rounded border border-border/60 bg-background px-1 py-1 text-xs disabled:opacity-40"
          />
          <span className="mono text-[10px] text-muted-foreground">%</span>
        </Filter>
      </div>

      <div className="overflow-x-auto rounded-md border border-border/60 bg-card/30">
        <table className="w-full min-w-[1000px] text-xs">
          <thead className="bg-card/60 text-[10px] uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-right">#</th>
              <th className="px-2 py-2 text-left">Player</th>
              <th className="px-2 py-2 text-left">Team</th>
              <th className="px-2 py-2 text-left">Opp</th>
              <th className="px-2 py-2 text-left">Category</th>
              <th className="px-2 py-2 text-right">Sim Mean</th>
              <th className="px-2 py-2 text-right">Sim Prob</th>
              <th className="px-2 py-2 text-right">Diamond</th>
              <th className="px-2 py-2 text-right">Conf</th>
              <th className="px-2 py-2 text-right">Consensus</th>
              <th className="px-2 py-2 text-left">Alignment</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {display.map((r, i) => {
              const tone = consensusTone(r.consensus);
              const isOpen = expanded === r.key;
              return (
                <>
                  <tr key={r.key} className="border-t border-border/30">
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
                    <td className="px-2 py-1 text-foreground">{r.catLabel}</td>
                    <td className="px-2 py-1 text-right mono tabular-nums text-edge">{fmtMean(r.simMean, r.meanDigits)}</td>
                    <td className="px-2 py-1 text-right mono tabular-nums">{fmtPct(r.simProb)}</td>
                    <td className="px-2 py-1 text-right mono tabular-nums">{fmtInt(r.diamondScore)}</td>
                    <td className="px-2 py-1 text-right mono tabular-nums text-muted-foreground">{fmtInt(r.confidence)}</td>
                    <td className="px-2 py-1 text-right">
                      <span className={`mono inline-block rounded border px-1.5 py-0.5 tabular-nums ${ALIGN_CLASS[tone]}`}>
                        {r.consensus.toFixed(0)}
                      </span>
                    </td>
                    <td className="px-2 py-1">
                      <span className={`mono inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${ALIGN_CLASS[alignmentTone(r.alignment)]}`}>
                        {r.alignment}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : r.key)}
                        className="mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
                      >
                        {isOpen ? "Hide" : "Why"}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${r.key}:exp`} className="border-t border-border/20 bg-background/40">
                      <td colSpan={12} className="px-4 py-3">
                        <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-3">
                          <Drawer label="Diamond Score percentile" value={`${fmtPctile(r.dsPct)} in ${r.catLabel}`} sub={`weight ${(r.weights.ds * 100).toFixed(1)}% · +${r.contributions.ds.toFixed(1)}`} />
                          <Drawer label="Sim Mean percentile" value={`${fmtPctile(r.meanPct)} in ${r.catLabel}`} sub={`weight ${(r.weights.mean * 100).toFixed(1)}% · +${r.contributions.mean.toFixed(1)}`} />
                          <Drawer
                            label="Sim Probability percentile"
                            value={r.probAvailable ? `${fmtPctile(r.probPct)} in ${r.catLabel}` : "not available"}
                            sub={r.probAvailable ? `weight ${(r.weights.prob * 100).toFixed(1)}% · +${r.contributions.prob.toFixed(1)}` : "weight redistributed to Diamond Score + Sim Mean"}
                          />
                          <Drawer label="Confidence" value={fmtInt(r.confidence)} sub={`engine confidence ${(r.confidence ?? 0)}`} />
                          <Drawer label="Lineup" value={r.lineupStatus ?? "—"} sub={`factor ${lineupFactor(r.lineupStatus).toFixed(2)}`} />
                          <Drawer label="Result" value={r.alignment} sub={`Consensus ${r.consensus.toFixed(1)} / 100 · display-only`} />
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {display.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-8 text-center text-muted-foreground">
                  No qualifying rows for this slate / filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Consensus = 40% Diamond Score percentile · 30% Sim Mean percentile · 20% Sim Probability percentile · 10% Confidence/lineup.
        When a real probability isn't available, the 20% is redistributed to Diamond Score and Sim Mean.
        Percentiles are computed strictly within each category and slate — Hits vs Hits, HR vs HR, never across categories.
        A high consensus score means the signals agree within that category, not that the event is the most likely to happen on the slate.
        For raw event likelihood, use the <span className="text-foreground">High-Probability Outcomes</span> view.
      </p>
    </section>
    </>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">{children}</span>
    </label>
  );
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mono rounded border px-2 py-1 text-[11px] uppercase tracking-widest ${
        on
          ? "border-primary/60 bg-primary/15 text-primary"
          : "border-border/60 bg-background text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Drawer({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-border/40 bg-card/40 px-3 py-2">
      <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mono text-sm text-foreground">{value}</div>
      {sub && <div className="mono text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
