/**
 * Live Tracker — display-only view of locked Diamond forecasts alongside
 * live MLB actuals. Reads persisted snapshots via getSimulationLeaders;
 * polls live actuals every 45s. Never re-runs the simulator and never
 * modifies projected means, probabilities, Diamond Score, or timestamps.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getSimulationLeaders, type SimLeaderHitterRow, type SimLeaderPitcherRow } from "@/lib/sim.functions";
import { getActualsForDate, type ActualsPayload, type HitterActual, type PitcherActual } from "@/lib/actuals.functions";
import { buildFullProjectionAudit } from "@/lib/results-helpers";
import { todayInAppTz } from "@/lib/timezone";

const leadersQ = (date: string) => queryOptions({
  queryKey: ["live-tracker-leaders", date],
  queryFn: () => getSimulationLeaders({ data: { date } }),
  staleTime: 60_000,
});
const actualsQ = (date: string) => queryOptions({
  queryKey: ["live-tracker-actuals", date],
  queryFn: () => getActualsForDate({ data: { date } }),
  refetchInterval: 45_000,
  refetchOnWindowFocus: true,
  staleTime: 30_000,
});

export const Route = createFileRoute("/_authenticated/today/live")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Live Tracker · Diamond" },
      { name: "description", content: "Watch every locked Diamond forecast unfold in real time. Display-only — no live re-simulation." },
    ],
  }),
  loader: async ({ context }) => {
    const date = todayInAppTz();
    await Promise.all([
      context.queryClient.ensureQueryData(leadersQ(date)),
      context.queryClient.ensureQueryData(actualsQ(date)),
    ]);
    return { date };
  },
  component: LiveTrackerPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load Live Tracker: {error.message}</div>
  ),
});

type Game = {
  gamePk: number;
  state: "live" | "final" | "pending";
  hitters: SimLeaderHitterRow[];
  pitchers: SimLeaderPitcherRow[];
};

function LiveTrackerPage() {
  const { date } = Route.useLoaderData();
  const { data: leaders } = useSuspenseQuery(leadersQ(date));
  const { data: actuals, dataUpdatedAt } = useQuery({ ...actualsQ(date), initialData: undefined });

  const games = useMemo<Game[]>(() => {
    const map = new Map<number, Game>();
    const stateOf = (pk: number | null): "live" | "final" | "pending" => {
      if (pk == null || !actuals) return "pending";
      if (actuals.finalGames.includes(pk)) return "final";
      if (actuals.liveGames.includes(pk)) return "live";
      return "pending";
    };
    for (const h of leaders.hitters) {
      if (h.mlb_game_id == null) continue;
      const g = map.get(h.mlb_game_id) ?? { gamePk: h.mlb_game_id, state: stateOf(h.mlb_game_id), hitters: [], pitchers: [] };
      g.hitters.push(h);
      map.set(h.mlb_game_id, g);
    }
    for (const p of leaders.pitchers) {
      if (p.mlb_game_id == null) continue;
      const g = map.get(p.mlb_game_id) ?? { gamePk: p.mlb_game_id, state: stateOf(p.mlb_game_id), hitters: [], pitchers: [] };
      g.pitchers.push(p);
      map.set(p.mlb_game_id, g);
    }
    const list = Array.from(map.values());
    // live first, then pending, then final
    const ord = { live: 0, pending: 1, final: 2 } as const;
    list.sort((a, b) => ord[a.state] - ord[b.state]);
    return list;
  }, [leaders, actuals]);

  const livecount = games.filter((g) => g.state === "live").length;
  const finalcount = games.filter((g) => g.state === "final").length;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8 space-y-6">
      <header className="space-y-2">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary flex items-center gap-2">
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-rose-500" />
          Live Tracker
        </div>
        <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">Today, as it happens</h1>
        <p className="text-sm text-muted-foreground">
          Locked pregame forecasts vs. live MLB actuals. Diamond never re-simulates or
          modifies a forecast after first pitch — only the actuals refresh, every 45 seconds.
        </p>
        <div className="mono flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-widest text-muted-foreground">
          <span>{date}</span>
          <span>{livecount} live</span>
          <span>{finalcount} final</span>
          {dataUpdatedAt ? <span>actuals @ {new Date(dataUpdatedAt).toLocaleTimeString()}</span> : null}
        </div>
      </header>

      {games.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 bg-card/40 p-10 text-center text-sm text-muted-foreground">
          No tracked games yet.
        </div>
      ) : (
        <div className="space-y-3">
          {games.map((g) => <GameBlock key={g.gamePk} g={g} actuals={actuals} />)}
        </div>
      )}
    </div>
  );
}

function GameBlock({ g, actuals }: { g: Game; actuals: ActualsPayload | undefined }) {
  const [open, setOpen] = useState(g.state === "live");
  const hitterCount = g.hitters.length;
  const pitcherCount = g.pitchers.length;
  const stateLabel = g.state === "live" ? "LIVE" : g.state === "final" ? "FINAL" : "PRE";
  const stateTone =
    g.state === "live" ? "bg-rose-500/15 border-rose-500/40 text-rose-200"
    : g.state === "final" ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-200"
    : "bg-card border-border/40 text-muted-foreground";

  // header line: build matchup string from first hitter / pitcher rows
  const teams = (() => {
    const sample = g.hitters[0] ?? g.pitchers[0];
    if (!sample) return "—";
    return `${sample.team_abbrev} vs ${sample.opp_abbrev}`;
  })();

  return (
    <section className="rounded-lg border border-border/60 bg-card/40">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <div className="flex items-center gap-3">
          <span className={`mono rounded border px-2 py-0.5 text-[10px] uppercase tracking-widest ${stateTone}`}>{stateLabel}</span>
          <span className="font-display text-base font-semibold">{teams}</span>
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {hitterCount} hitters · {pitcherCount} pitchers
          </span>
        </div>
        <Link to="/matchups/$gamePk" params={{ gamePk: String(g.gamePk) }}
          className="mono text-[10px] uppercase tracking-widest text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}>
          Matchup ↗
        </Link>
      </button>

      {open ? (
        <div className="border-t border-border/40 p-3 space-y-4">
          {g.hitters.length > 0 ? <HitterRows rows={g.hitters} actuals={actuals} /> : null}
          {g.pitchers.length > 0 ? <PitcherRows rows={g.pitchers} actuals={actuals} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function fmt(v: number | null | undefined, d = 2) { return v == null ? "—" : v.toFixed(d); }
function pct(v: number | null | undefined) { return v == null ? "—" : `${(v * 100).toFixed(0)}%`; }

function HitterRows({ rows, actuals }: { rows: SimLeaderHitterRow[]; actuals: ActualsPayload | undefined }) {
  const sorted = [...rows].sort((a, b) => (a.batting_order ?? 99) - (b.batting_order ?? 99));
  return (
    <div className="overflow-x-auto rounded-md border border-border/40 bg-card/30">
      <table className="w-full text-left text-xs">
        <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <tr className="border-b border-border/40">
            <th className="px-2 py-1.5">#</th>
            <th className="px-2 py-1.5">Hitter</th>
            <th className="px-2 py-1.5 text-right">DS</th>
            <th className="px-2 py-1.5 text-right">μH</th>
            <th className="px-2 py-1.5 text-right">μTB</th>
            <th className="px-2 py-1.5 text-right">μHR</th>
            <th className="px-2 py-1.5 text-right">μRBI</th>
            <th className="px-2 py-1.5 text-right">μR</th>
            <th className="px-2 py-1.5 text-right">P(H)</th>
            <th className="px-2 py-1.5">Live</th>
            <th className="px-2 py-1.5">Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((h) => {
            const act: HitterActual | undefined = h.mlb_id != null && actuals ? actuals.hitters[String(h.mlb_id)] : undefined;
            const line = act ? `${act.H ?? 0}H / ${act.TB ?? 0}TB / ${act.HR ?? 0}HR / ${act.RBI ?? 0}RBI` : "—";
            const status = liveHitterStatus(h, act, actuals);
            return (
              <tr key={`${h.mlb_id}:${h.game_id}`} className="border-t border-border/30">
                <td className="px-2 py-1.5 mono tabular-nums text-muted-foreground">{h.batting_order ?? "—"}</td>
                <td className="px-2 py-1.5">
                  {h.mlb_id ? <Link to="/players/$playerId" params={{ playerId: String(h.mlb_id) }} className="font-semibold hover:underline">{h.player_name}</Link> : <span className="font-semibold">{h.player_name}</span>}
                </td>
                <td className="px-2 py-1.5 text-right mono tabular-nums">{h.diamond_score?.toFixed(0) ?? "—"}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">{fmt(h.H?.mean)}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">{fmt(h.TB?.mean)}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">{fmt(h.HR?.mean)}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">{fmt(h.RBI?.mean)}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">{fmt(h.R?.mean)}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums">{pct(h.card_probabilities.hit)}</td>
                <td className="px-2 py-1.5 mono tabular-nums">{line}</td>
                <td className={`px-2 py-1.5 mono text-[10px] uppercase tracking-widest ${status.tone}`}>{status.label}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PitcherRows({ rows, actuals }: { rows: SimLeaderPitcherRow[]; actuals: ActualsPayload | undefined }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border/40 bg-card/30">
      <table className="w-full text-left text-xs">
        <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <tr className="border-b border-border/40">
            <th className="px-2 py-1.5">Pitcher</th>
            <th className="px-2 py-1.5 text-right">DS</th>
            <th className="px-2 py-1.5 text-right">μK</th>
            <th className="px-2 py-1.5 text-right">μOuts</th>
            <th className="px-2 py-1.5 text-right">μBB</th>
            <th className="px-2 py-1.5 text-right">P(W)</th>
            <th className="px-2 py-1.5 text-right">P(QS)</th>
            <th className="px-2 py-1.5">Live</th>
            <th className="px-2 py-1.5">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const act: PitcherActual | undefined = p.mlb_id != null && actuals ? actuals.pitchers[String(p.mlb_id)] : undefined;
            const ip = act ? `${Math.floor(act.outs / 3)}.${act.outs % 3}` : "—";
            const line = act ? `${ip}IP / ${act.K}K / ${act.BB}BB / ${act.ER}ER` : "—";
            const status = livePitcherStatus(p, act, actuals);
            return (
              <tr key={`${p.mlb_id}:${p.game_id}`} className="border-t border-border/30">
                <td className="px-2 py-1.5">
                  {p.mlb_id ? <Link to="/players/$playerId" params={{ playerId: String(p.mlb_id) }} className="font-semibold hover:underline">{p.player_name}</Link> : <span className="font-semibold">{p.player_name}</span>}
                </td>
                <td className="px-2 py-1.5 text-right mono tabular-nums">{p.diamond_score?.toFixed(0) ?? "—"}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">{fmt(p.K?.mean, 1)}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">{fmt(p.outs?.mean, 1)}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums text-edge">{fmt(p.BB?.mean, 1)}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums">{pct(p.win_probability)}</td>
                <td className="px-2 py-1.5 text-right mono tabular-nums">{pct(p.quality_start_probability)}</td>
                <td className="px-2 py-1.5 mono tabular-nums">{line}</td>
                <td className={`px-2 py-1.5 mono text-[10px] uppercase tracking-widest ${status.tone}`}>{status.label}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function liveHitterStatus(
  h: SimLeaderHitterRow,
  act: HitterActual | undefined,
  actuals: ActualsPayload | undefined,
): { label: string; tone: string } {
  if (!actuals || h.mlb_game_id == null) return { label: "—", tone: "text-muted-foreground" };
  const isFinal = actuals.finalGames.includes(h.mlb_game_id);
  const isLive = actuals.liveGames.includes(h.mlb_game_id);
  if (!isFinal && !isLive) return { label: "Pre", tone: "text-muted-foreground" };
  const mean = h.H?.mean ?? 0;
  const actH = act?.H ?? 0;
  if (isFinal) {
    if (actH >= Math.max(1, Math.round(mean)) + 1) return { label: "Beat", tone: "text-emerald-300" };
    if (actH >= Math.max(1, Math.round(mean))) return { label: "Met", tone: "text-emerald-300" };
    if (actH > 0) return { label: "Close", tone: "text-amber-300" };
    return { label: "Missed", tone: "text-rose-300" };
  }
  // live
  if (actH >= Math.max(1, Math.round(mean))) return { label: "Hit Event", tone: "text-emerald-300" };
  if (actH > 0) return { label: "On Pace", tone: "text-sky-300" };
  return { label: "Behind", tone: "text-amber-300" };
}

function livePitcherStatus(
  p: SimLeaderPitcherRow,
  act: PitcherActual | undefined,
  actuals: ActualsPayload | undefined,
): { label: string; tone: string } {
  if (!actuals || p.mlb_game_id == null) return { label: "—", tone: "text-muted-foreground" };
  const isFinal = actuals.finalGames.includes(p.mlb_game_id);
  const isLive = actuals.liveGames.includes(p.mlb_game_id);
  if (!isFinal && !isLive) return { label: "Pre", tone: "text-muted-foreground" };
  const meanK = p.K?.mean ?? 0;
  const actK = act?.K ?? 0;
  if (isFinal) {
    if (actK >= meanK + 1) return { label: "Beat", tone: "text-emerald-300" };
    if (actK >= meanK - 0.5) return { label: "Met", tone: "text-emerald-300" };
    return { label: "Missed", tone: "text-rose-300" };
  }
  if (actK >= meanK) return { label: "Hit Event", tone: "text-emerald-300" };
  if (actK >= meanK * 0.6) return { label: "On Pace", tone: "text-sky-300" };
  return { label: "Behind", tone: "text-amber-300" };
}

// Silence unused import warning while keeping the helper available for
// possible future audit drawer expansions.
void buildFullProjectionAudit;
