import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getGameHub, type GameHubTeamSide } from "@/lib/game-hub.functions";
import { getMlbMovers, type HitterMover, type PitcherMover } from "@/lib/movers.functions";
import { todayInAppTz } from "@/lib/timezone";

function gameQuery(gamePk: number) {
  return queryOptions({
    queryKey: ["game-hub", gamePk],
    queryFn: () => getGameHub({ data: { gamePk } }),
    staleTime: 30_000,
    refetchInterval: (query) => {
      if (typeof document !== "undefined" && document.hidden) return false;
      return query.state.data?.isLive ? 60_000 : false;
    },
  });
}
const moversQ = queryOptions({
  queryKey: ["movers", "game-hub"],
  queryFn: () => getMlbMovers({ data: { date: todayInAppTz() } }),
  staleTime: 5 * 60 * 1000,
});

export const Route = createFileRoute("/_authenticated/game/$gamePk")({
  head: ({ params }) => ({
    meta: [
      { title: `Game ${params.gamePk} — Diamond` },
      { name: "description", content: "Live MLB game context: score, lineups, starters, and in-game activity." },
      { property: "og:title", content: `Game Hub — Diamond` },
      { property: "og:description", content: "Score, lineups, starting pitchers, and in-game activity for this MLB game." },
    ],
  }),
  loader: ({ context, params }) => {
    const pk = Number(params.gamePk);
    if (!Number.isFinite(pk) || pk <= 0) throw notFound();
    return context.queryClient.ensureQueryData(gameQuery(pk));
  },
  component: GameHubPage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-sm text-[var(--warm-muted)]">Couldn't load game: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-6">Game not found.</div>,
});

function GameHubPage() {
  const { gamePk } = Route.useParams();
  const pk = Number(gamePk);
  const { data: game } = useSuspenseQuery(gameQuery(pk));
  const movers = useQuery(moversQ);

  const inGameTeamIds = new Set<number>([game.away.teamId, game.home.teamId].filter((x): x is number => !!x));
  const relevantHitters = (movers.data?.hitters.risers ?? [])
    .concat(movers.data?.hitters.fallers ?? [])
    .filter((m) => m.teamId != null && inGameTeamIds.has(m.teamId));
  const relevantPitchers = (movers.data?.pitchers.risers ?? [])
    .concat(movers.data?.pitchers.fallers ?? [])
    .filter((m) => m.teamId != null && inGameTeamIds.has(m.teamId));

  const startLocal = new Date(game.startTimeUtc).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-10">
      {/* Header */}
      <div className="border-b border-[var(--border)] pb-5">
        <div className="eyebrow text-[var(--primary)]">Game Hub · gamePk {game.gamePk}</div>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-4">
          <h1 className="text-[28px] leading-tight text-[var(--cream)] md:text-[36px]">
            {game.away.abbreviation} @ {game.home.abbreviation}
          </h1>
          <div className="mono text-right text-[11px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
            {game.status}
            {game.isLive && game.inning ? <> · {game.inningHalf} {game.inning}</> : null}
            {game.isScheduled ? <> · First pitch {startLocal}</> : null}
            {game.venue ? <> · {game.venue}</> : null}
          </div>
        </div>

        {/* Score */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <ScorePanel side={game.away} label="Away" live={game.isLive || game.isFinal} />
          <ScorePanel side={game.home} label="Home" live={game.isLive || game.isFinal} />
        </div>

        {/* Live line */}
        {game.isLive ? (
          <div className="mono mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--parchment)]">
            {game.currentBatter ? <span>At bat · {game.currentBatter}</span> : null}
            {game.currentPitcher ? <span>Pitching · {game.currentPitcher}</span> : null}
            {game.lastPlay ? <span className="text-[var(--warm-muted)]">Last · {game.lastPlay}</span> : null}
          </div>
        ) : null}
      </div>

      {/* Starting pitchers */}
      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <StarterCard side={game.away} label={`${game.away.abbreviation} · Starting pitcher`} />
        <StarterCard side={game.home} label={`${game.home.abbreviation} · Starting pitcher`} />
      </section>

      {/* Lineups */}
      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <LineupCard side={game.away} />
        <LineupCard side={game.home} />
      </section>

      {/* Players moving in this game */}
      <section className="mt-6">
        <div className="mono mb-2 text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
          Players Moving in This Game · Diamond Live 14-day
        </div>
        {movers.isLoading ? (
          <div className="text-xs text-[var(--warm-muted)]">Loading movers…</div>
        ) : relevantHitters.length === 0 && relevantPitchers.length === 0 ? (
          <div className="rounded-sm border border-dashed border-[var(--border)] px-3 py-3 text-[11px] text-[var(--warm-muted)]">
            No qualifying risers or fallers on either roster right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {relevantHitters.map((m) => <MoverRow key={`h-${m.mlbId}`} m={m} kind="hitter" />)}
            {relevantPitchers.map((m) => <MoverRow key={`p-${m.mlbId}`} m={m} kind="pitcher" />)}
          </div>
        )}
      </section>

      {/* Live in-game activity */}
      {game.isLive || game.isFinal ? (
        <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <InGameActivity title={`${game.away.abbreviation} · In-game`} side={game.away} />
          <InGameActivity title={`${game.home.abbreviation} · In-game`} side={game.home} />
        </section>
      ) : null}

      <div className="mono mt-6 text-[10px] text-[var(--warm-muted)]">
        Source · MLB Stats API · fetched {new Date(game.fetchedAt).toLocaleTimeString()}
      </div>
    </main>
  );
}

function ScorePanel({ side, label, live }: { side: GameHubTeamSide; label: string; live: boolean }) {
  return (
    <div className="rounded-sm border border-[var(--border)] px-4 py-3">
      <div className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">{label}{side.record ? ` · ${side.record}` : ""}</div>
      <div className="mt-1 flex items-baseline justify-between">
        <div className="text-xl font-semibold text-[var(--cream)]">{side.name}</div>
        <div className="mono text-3xl font-bold tabular-nums text-[var(--cream)]">{live ? (side.score ?? "0") : "—"}</div>
      </div>
    </div>
  );
}

function StarterCard({ side, label }: { side: GameHubTeamSide; label: string }) {
  const starter = side.pitchers.find((p) => p.isStarter) ?? side.pitchers[0];
  return (
    <div className="rounded-sm border border-[var(--border)] px-4 py-3">
      <div className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">{label}</div>
      {starter ? (
        <>
          <Link to="/player/$mlbId" params={{ mlbId: String(starter.mlbId) }} className="mt-1 block text-lg font-semibold text-[var(--cream)] hover:text-[var(--brass)]">
            {starter.name}
          </Link>
          <div className="mono mt-1 text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
            {starter.isProbable ? "Probable starter · MLB schedule" : "Confirmed starter"}
          </div>
          {starter.pitchingLine ? <div className="mono mt-1 text-[11px] text-[var(--parchment)]">{starter.pitchingLine}</div> : null}
        </>
      ) : (
        <div className="mt-1 text-[11px] text-[var(--warm-muted)]">Waiting for verified probable starter.</div>
      )}
    </div>
  );
}

function LineupCard({ side }: { side: GameHubTeamSide }) {
  const stateLabel =
    side.lineupState === "confirmed" ? "Confirmed / posted" :
    side.lineupState === "projected" ? "Projected" :
    "Not posted";
  return (
    <div className="rounded-sm border border-[var(--border)] px-4 py-3">
      <div className="mono flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
        <span>{side.abbreviation} · Lineup</span>
        <span className="text-[var(--brass)]">{stateLabel}</span>
      </div>
      {side.battingOrder.length === 0 ? (
        <div className="mt-2 text-[11px] text-[var(--warm-muted)]">No official lineup posted yet.</div>
      ) : (
        <ol className="mt-2 space-y-1 text-xs">
          {side.battingOrder.map((b) => (
            <li key={b.mlbId} className="flex items-baseline gap-2 border-t border-[var(--border)] pt-1">
              <span className="mono w-4 text-[var(--warm-muted)]">{b.battingOrder}.</span>
              <Link to="/player/$mlbId" params={{ mlbId: String(b.mlbId) }} className="flex-1 font-semibold text-[var(--cream)] hover:text-[var(--brass)]">
                {b.name}
              </Link>
              <span className="mono text-[10px] text-[var(--warm-muted)]">{b.position}</span>
              {b.battingLine ? <span className="mono text-[10px] tabular-nums text-[var(--parchment)]">{b.battingLine}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function InGameActivity({ title, side }: { title: string; side: GameHubTeamSide }) {
  const active = side.pitchers.filter((p) => p.pitchingLine);
  const batters = side.battingOrder.filter((b) => b.battingLine);
  if (active.length === 0 && batters.length === 0) return null;
  return (
    <div className="rounded-sm border border-[var(--border)] px-4 py-3">
      <div className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">{title}</div>
      {active.length ? (
        <div className="mt-2 space-y-1">
          {active.map((p) => (
            <div key={p.mlbId} className="flex items-baseline justify-between gap-2 text-xs">
              <Link to="/player/$mlbId" params={{ mlbId: String(p.mlbId) }} className="font-semibold text-[var(--cream)] hover:text-[var(--brass)]">{p.name}</Link>
              <span className="mono text-[11px] text-[var(--parchment)]">{p.pitchingLine}</span>
            </div>
          ))}
        </div>
      ) : null}
      {batters.length ? (
        <div className="mt-2 space-y-1 border-t border-[var(--border)] pt-2">
          {batters.slice(0, 6).map((b) => (
            <div key={b.mlbId} className="flex items-baseline justify-between gap-2 text-xs">
              <Link to="/player/$mlbId" params={{ mlbId: String(b.mlbId) }} className="font-semibold text-[var(--cream)] hover:text-[var(--brass)]">{b.name}</Link>
              <span className="mono text-[11px] text-[var(--parchment)]">{b.battingLine}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MoverRow({ m, kind }: { m: HitterMover | PitcherMover; kind: "hitter" | "pitcher" }) {
  const tone =
    m.status === "riser" ? "border-[color-mix(in_oklab,var(--field)_55%,transparent)] text-[var(--field)]" :
    m.status === "faller" ? "border-[color-mix(in_oklab,var(--cardinal)_55%,transparent)] text-[var(--cardinal)]" :
    "border-[var(--border)] text-[var(--warm-muted)]";
  const label = m.status === "riser" ? "Riser" : m.status === "faller" ? "Faller" : "Early Sample";
  return (
    <Link to="/player/$mlbId" params={{ mlbId: String(m.mlbId) }} className="block rounded-sm border border-[var(--border)] px-3 py-2 transition-colors hover:bg-[color-mix(in_oklab,var(--charcoal)_75%,transparent)]">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-semibold text-[var(--cream)]">{m.name}</div>
        <span className={`mono rounded-sm px-1.5 py-0.5 text-[9px] uppercase tracking-widest border ${tone}`}>{label}</span>
      </div>
      <div className="mono mt-1 text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
        {m.team} · {kind === "hitter" ? "H" : "P"}
      </div>
      <div className="mt-1 text-[11px] text-[var(--parchment)]">{m.reason}</div>
    </Link>
  );
}
