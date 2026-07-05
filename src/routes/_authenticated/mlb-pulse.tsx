import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import {
  getMlbPulse,
  type PulseGame,
  type PulseHitter,
  type PulsePayload,
  type PulsePitcher,
} from "@/lib/pulse.functions";
import { todayInAppTz } from "@/lib/timezone";

const searchSchema = z.object({
  date: z.string().optional(),
});

function pulseQuery(date: string) {
  return queryOptions({
    queryKey: ["mlb-pulse", date],
    queryFn: () => getMlbPulse({ data: { date } }),
    staleTime: 30_000,
    refetchInterval: (query) => {
      if (typeof document !== "undefined" && document.hidden) return false;
      return query.state.data?.hasLiveGames ? 60_000 : false;
    },
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

export const Route = createFileRoute("/_authenticated/mlb-pulse")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "MLB Pulse — Diamond" },
      { name: "description", content: "Today's MLB pulse from verified raw game, lineup, and box-score facts." },
    ],
  }),
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => ({ date: search.date ?? todayInAppTz() }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(pulseQuery(deps.date)),
  component: MlbPulsePage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load MLB Pulse: {error.message}</div>
  ),
});

type Filter = "all" | "live" | "upcoming" | "final";

function MlbPulsePage() {
  const search = Route.useSearch();
  const date = search.date ?? todayInAppTz();
  const navigate = useNavigate({ from: Route.fullPath });
  const query = useQuery(pulseQuery(date));
  const data = query.data;
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void query.refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [query]);

  const games = useMemo(() => {
    const rows = data?.games ?? [];
    if (filter === "all") return rows;
    return rows.filter((g) => g.status === filter);
  }, [data?.games, filter]);

  return (
    <>
      <main className="mx-auto max-w-7xl space-y-5 px-4 py-5 md:px-6 md:py-8">
        <PulseNav />
        <Header
          data={data}
          date={date}
          isFetching={query.isFetching}
          hasError={!!query.error}
          onRefresh={() => query.refetch()}
          onToday={() => navigate({ search: () => ({}) })}
        />

        {query.error && data ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            Latest refresh failed. Showing the last successful Pulse data; live data may be delayed.
          </div>
        ) : null}

        {data?.warnings.length ? (
          <div className="rounded-md border border-border/60 bg-card/50 px-3 py-2 text-sm text-muted-foreground">
            {data.warnings.join(" ")}
          </div>
        ) : null}

        {!data ? (
          <EmptyState title="Loading MLB Pulse" body="Gathering verified game and box-score facts." />
        ) : data.games.length === 0 ? (
          <EmptyState title="No games found" body="No MLB games are available for this selected date." />
        ) : (
          <>
            <GameStrip games={games} allGames={data.games} filter={filter} setFilter={setFilter} />
            <PulseTables data={data} filter={filter} />
          </>
        )}
      </main>
    </>
  );
}

function PulseNav() {
  return (
    <nav className="flex items-center gap-2 overflow-x-auto border-b border-[color-mix(in_oklab,var(--brass)_30%,transparent)] pb-2">
      <Link
        to="/mlb-pulse"
        className="mono whitespace-nowrap border-b-2 border-[var(--brass)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--cream)]"
      >
        Pulse
      </Link>
      <Link
        to="/"
        className="mono whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--warm-muted)] hover:text-[var(--cream)]"
      >
        Live
      </Link>
      <Link
        to="/hitters"
        className="mono whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--warm-muted)] hover:text-[var(--cream)]"
      >
        Hitters
      </Link>
      <Link
        to="/pitchers"
        className="mono whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--warm-muted)] hover:text-[var(--cream)]"
      >
        Pitchers
      </Link>
    </nav>
  );
}

function Header({
  data,
  date,
  isFetching,
  hasError,
  onRefresh,
  onToday,
}: {
  data: PulsePayload | undefined;
  date: string;
  isFetching: boolean;
  hasError: boolean;
  onRefresh: () => void;
  onToday: () => void;
}) {
  return (
    <header className="border-b border-[color-mix(in_oklab,var(--brass)_30%,transparent)] pb-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow text-[var(--brass)]">Today&apos;s Slate</div>
          <h1 className="font-display mt-1 text-[36px] leading-tight text-[var(--cream)] md:text-[52px]">
            MLB Pulse
          </h1>
          <div className="mono mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-[0.22em] text-[var(--warm-muted)]">
            <span>{date}</span>
            <span>Updated {fmtTime(data?.overallUpdatedAt)}</span>
            <span>{data?.hasLiveGames ? "Live refresh · 60s" : "Auto-refresh paused"}</span>
            {hasError ? <span className="text-[var(--cardinal)]">Data may be delayed</span> : null}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onToday}
            className="mono rounded-sm border border-[color-mix(in_oklab,var(--brass)_35%,transparent)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--warm-muted)] hover:text-[var(--cream)]"
          >
            Today
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            className="mono rounded-sm bg-[var(--field)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--cream)] disabled:opacity-60 hover:brightness-110"
          >
            {isFetching ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>
    </header>
  );
}


function GameStrip({
  games,
  allGames,
  filter,
  setFilter,
}: {
  games: PulseGame[];
  allGames: PulseGame[];
  filter: Filter;
  setFilter: (v: Filter) => void;
}) {
  const counts: Record<Filter, number> = {
    all: allGames.length,
    live: allGames.filter((g) => g.status === "live").length,
    upcoming: allGames.filter((g) => g.status === "upcoming").length,
    final: allGames.filter((g) => g.status === "final").length,
  };
  return (
    <section className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {(["all", "live", "upcoming", "final"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`mono whitespace-nowrap rounded-full border px-3 py-1 text-[11px] uppercase tracking-widest ${
              filter === f
                ? "border-primary/60 bg-primary/15 text-primary"
                : "border-border/60 bg-card/50 text-muted-foreground hover:text-foreground"
            }`}
          >
            {label(f)} {counts[f]}
          </button>
        ))}
      </div>
      {games.length === 0 ? (
        <EmptyState title="No games in this filter" body="Try another status filter." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {games.map((game) => <GameCard key={game.id} game={game} />)}
        </div>
      )}
    </section>
  );
}

function GameCard({ game }: { game: PulseGame }) {
  const live = game.status === "live";
  const detail = statusDetail(game);
  return (
    <article className={`rounded-sm border p-3 ${live ? "border-[var(--field)] bg-[color-mix(in_oklab,var(--field)_12%,transparent)]" : "border-[color-mix(in_oklab,var(--brass)_25%,transparent)] bg-[color-mix(in_oklab,var(--charcoal)_80%,transparent)]"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`mono rounded-full px-2 py-0.5 text-[10px] uppercase tracking-widest ${statusClass(game.status)}`}>
          {statusLabel(game)}
        </span>
        <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Updated {fmtTime(game.updatedAt)}</span>
      </div>
      {detail ? (
        <div className="mono mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
          {detail}
        </div>
      ) : null}
      <div className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        <TeamLine team={game.away.abbreviation} score={game.away.score} />
        <TeamLine team={game.home.abbreviation} score={game.home.score} />
      </div>
      <div className="mt-3 grid gap-1 text-xs text-muted-foreground">
        <InfoLine label={`${game.away.abbreviation} SP`} value={game.probablePitchers.away.name ?? "Waiting for verified data"} source={game.probablePitchers.away.source} />
        <InfoLine label={`${game.home.abbreviation} SP`} value={game.probablePitchers.home.name ?? "Waiting for verified data"} source={game.probablePitchers.home.source} />
        <InfoLine label={`${game.away.abbreviation} lineup`} value={game.lineupState.away.label} source={game.lineupState.away.source ?? "Unavailable"} />
        <InfoLine label={`${game.home.abbreviation} lineup`} value={game.lineupState.home.label} source={game.lineupState.home.source ?? "Unavailable"} />
      </div>
    </article>
  );
}

function PulseTables({ data, filter }: { data: PulsePayload; filter: Filter }) {
  const allowedGameIds = new Set(
    data.games.filter((g) => filter === "all" || g.status === filter).map((g) => g.id),
  );
  const hitters = data.hitters.filter((h) => allowedGameIds.has(h.gameId));
  const pitchers = data.pitchers.filter((p) => allowedGameIds.has(p.gameId));
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="space-y-2">
        <SectionTitle title="Hitters in Action" count={hitters.length} />
        {hitters.length ? <HittersTable rows={hitters} /> : <EmptyState title="No verified hitters yet" body="Waiting for verified lineup or box-score data." />}
      </section>
      <section className="space-y-2">
        <SectionTitle title="Pitchers in Action" count={pitchers.length} />
        {pitchers.length ? <PitchersTable rows={pitchers} /> : <EmptyState title="No pitchers yet" body="Waiting for probable starters or box-score data." />}
      </section>
    </div>
  );
}

function HittersTable({ rows }: { rows: PulseHitter[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60 bg-card/30">
      <table className="w-full text-left text-xs">
        <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <tr className="border-b border-border/50">
            <th className="px-2 py-2">Player</th>
            <th className="px-2">Team</th>
            <th className="px-2 text-right">Slot</th>
            <th className="px-2">Lineup</th>
            <th className="px-2">Today</th>
            <th className="px-2 text-right">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={`${h.gameId}:${h.mlbId ?? h.playerId ?? h.name}`} className="border-t border-border/30">
              <td className="px-2 py-2 font-semibold">
                {h.mlbId ? <Link to="/players/$playerId" params={{ playerId: String(h.mlbId) }} className="hover:text-primary">{h.name}</Link> : h.name}
                {h.position ? <span className="mono ml-1 text-[10px] text-muted-foreground">{h.position}</span> : null}
              </td>
              <td className="mono px-2 text-muted-foreground">{h.team || "—"}</td>
              <td className="mono px-2 text-right tabular-nums">{h.lineupSlot ?? "—"}</td>
              <td className="px-2">{h.lineupState.label}</td>
              <td className="mono px-2 tabular-nums">{formatHitterLine(h.today)}</td>
              <td className="mono px-2 text-right text-[10px] text-muted-foreground">{fmtTime(h.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PitchersTable({ rows }: { rows: PulsePitcher[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60 bg-card/30">
      <table className="w-full text-left text-xs">
        <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <tr className="border-b border-border/50">
            <th className="px-2 py-2">Pitcher</th>
            <th className="px-2">Team</th>
            <th className="px-2">Role</th>
            <th className="px-2">Today</th>
            <th className="px-2">Source</th>
            <th className="px-2 text-right">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={`${p.gameId}:${p.mlbId ?? p.playerId ?? p.name}:${p.role}`} className="border-t border-border/30">
              <td className="px-2 py-2 font-semibold">
                {p.mlbId ? <Link to="/players/$playerId" params={{ playerId: String(p.mlbId) }} className="hover:text-primary">{p.name}</Link> : p.name}
              </td>
              <td className="mono px-2 text-muted-foreground">{p.team || "—"}</td>
              <td className="px-2">{p.role === "probable-starter" ? "Probable starter" : "Active pitcher"}</td>
              <td className="mono px-2 tabular-nums">{formatPitcherLine(p.today)}</td>
              <td className="px-2">{p.source}</td>
              <td className="mono px-2 text-right text-[10px] text-muted-foreground">{fmtTime(p.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-end justify-between">
      <h2 className="font-display text-xl font-bold tracking-tight">{title}</h2>
      <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{count} rows</span>
    </div>
  );
}

function TeamLine({ team, score }: { team: string; score: number | null }) {
  return (
    <>
      <div className="font-display text-lg font-semibold">{team}</div>
      <div className="mono text-right text-lg font-bold tabular-nums">{score ?? "—"}</div>
    </>
  );
}

function InfoLine({ label, value, source }: { label: string; value: string; source: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className="min-w-0 truncate text-right text-foreground" title={source}>{value}</span>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-card/30 p-6 text-center">
      <div className="font-display text-lg font-semibold">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function label(filter: Filter): string {
  if (filter === "all") return "All";
  if (filter === "live") return "Live";
  if (filter === "upcoming") return "Upcoming";
  return "Final";
}

function statusLabel(game: PulseGame): string {
  switch (game.status) {
    case "live": return "Live";
    case "upcoming": return "Upcoming";
    case "final": return "Final";
    case "delayed": return "Delayed";
    case "postponed": return "Postponed";
    case "unavailable": return "Data Unavailable";
  }
}

function statusDetail(game: PulseGame): string | null {
  if (game.status === "live" && game.inning && game.inningHalf) return `${game.inningHalf} ${game.inning}`;
  if (game.status === "upcoming" && game.firstPitch) return `First pitch ${fmtTime(game.firstPitch)}`;
  return game.statusText && game.statusText !== statusLabel(game) ? game.statusText : null;
}

function statusClass(status: PulseGame["status"]): string {
  if (status === "live") return "bg-[color-mix(in_oklab,var(--field)_25%,transparent)] text-[var(--cream)] border border-[var(--field)]";
  if (status === "final") return "bg-[color-mix(in_oklab,var(--charcoal)_80%,transparent)] text-[var(--parchment)] border border-[color-mix(in_oklab,var(--brass)_35%,transparent)]";
  if (status === "delayed") return "bg-[color-mix(in_oklab,var(--cardinal)_20%,transparent)] text-[var(--cream)] border border-[var(--cardinal)]";
  if (status === "postponed") return "bg-[color-mix(in_oklab,var(--cardinal)_20%,transparent)] text-[var(--cream)] border border-[var(--cardinal)]";
  if (status === "unavailable") return "bg-[color-mix(in_oklab,var(--charcoal)_70%,transparent)] text-[var(--warm-muted)] border border-[color-mix(in_oklab,var(--warm-muted)_35%,transparent)]";
  return "bg-[color-mix(in_oklab,var(--brass)_15%,transparent)] text-[var(--parchment)] border border-[color-mix(in_oklab,var(--brass)_35%,transparent)]";
}


function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatHitterLine(a: PulseHitter["today"]): string {
  if (!a) return "Waiting for verified data";
  return `${a.H}-${a.AB}, ${a.R} R, ${a.RBI} RBI, ${a.BB} BB, ${a.K} K`;
}

function formatPitcherLine(a: PulsePitcher["today"]): string {
  if (!a) return "Waiting for verified data";
  const ip = a.inningsPitched ?? `${Math.floor(a.outs / 3)}.${a.outs % 3}`;
  const pitches = a.pitchCount == null ? "" : `, ${a.pitchCount} pitches`;
  return `${ip} IP, ${a.H} H, ${a.ER} ER, ${a.BB} BB, ${a.K} K, ${a.HR} HR${pitches}`;
}
