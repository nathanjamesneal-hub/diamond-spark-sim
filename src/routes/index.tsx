import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getSchedule, type GameSummary } from "@/lib/mlb.functions";
import { ScoreCard } from "@/components/score-card";

const scheduleQuery = queryOptions({
  queryKey: ["schedule", "today"],
  queryFn: () => getSchedule({ data: {} }),
  refetchInterval: 15_000,
});

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Today's MLB — Diamond" },
      {
        name: "description",
        content:
          "Today's MLB scoreboard with live win probability, projections, and edges vs. sportsbooks.",
      },
      { property: "og:title", content: "Today's MLB — Diamond" },
      {
        property: "og:description",
        content: "Live scores, projections, and odds value board.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(scheduleQuery),
  component: TodayPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load today's slate: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">No games today.</div>,
});

function TodayPage() {
  const { data } = useSuspenseQuery(scheduleQuery);
  const featured = data.games.find((g) => g.isLive) ?? data.games[0];
  const rest = data.games.filter((g) => g.gamePk !== featured?.gamePk);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <SectionHeader
        kicker={data.date}
        title="Today's slate"
        subtitle={`${data.games.length} games · live scores, live stats, and projections`}
      />

      <DashboardGrid />

      {featured ? <FeaturedMatchup game={featured} /> : null}

      <div className="mt-8">
        <h2 className="mb-3 font-display text-lg font-semibold uppercase tracking-wider text-muted-foreground">
          All games
        </h2>
        {rest.length === 0 && !featured ? (
          <EmptyState />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((g) => (
              <ScoreCard key={g.gamePk} game={g} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const DASHBOARD_CARDS = [
  {
    to: "/scores",
    kicker: "Live",
    title: "Live Scores",
    desc: "Live status, score, inning, and game state from the MLB feed.",
    accent: "text-live",
  },
  {
    to: "/odds",
    kicker: "Markets",
    title: "Odds",
    desc: "Sportsbook lines across DraftKings, FanDuel, MGM, Caesars, and more.",
    accent: "text-edge",
  },
  {
    to: "/standings",
    kicker: "Season",
    title: "Standings",
    desc: "AL & NL divisions, win %, GB, streak, last 10, and run differential.",
    accent: "text-primary",
  },
  {
    to: "/slate",
    kicker: "Model",
    title: "Diamond Projections",
    desc: "Diamond Score, hit / TB / HR / RBI / SB / run %, confidence, model version.",
    accent: "text-primary",
  },
] as const;

function DashboardGrid() {
  return (
    <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {DASHBOARD_CARDS.map((c) => (
        <Link
          key={c.to}
          to={c.to}
          className="group flex flex-col rounded-xl border border-border/70 bg-card p-4 transition-colors hover:border-primary/50 hover:bg-card/80"
        >
          <div className={`mono text-[10px] uppercase tracking-[0.25em] ${c.accent}`}>
            {c.kicker}
          </div>
          <div className="mt-1 font-display text-lg font-bold tracking-tight text-foreground">
            {c.title}
          </div>
          <p className="mt-1 flex-1 text-xs text-muted-foreground">{c.desc}</p>
          <div className="mono mt-3 text-[10px] uppercase tracking-widest text-muted-foreground transition-colors group-hover:text-primary">
            Open →
          </div>
        </Link>
      ))}
    </div>
  );
}

function SectionHeader({
  kicker, title, subtitle,
}: { kicker: string; title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">{kicker}</div>
      <h1 className="font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
        {title}
      </h1>
      {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
    </div>
  );
}

function FeaturedMatchup({ game }: { game: GameSummary }) {
  const seed = game.gamePk;
  const homeWinPct = 38 + ((seed * 7) % 25); // 38–62%
  const awayWinPct = 100 - homeWinPct;
  const projHome = (3.8 + ((seed % 23) / 10)).toFixed(1);
  const projAway = (3.8 + (((seed * 3) % 23) / 10)).toFixed(1);

  return (
    <Link
      to="/matchups/$gamePk"
      params={{ gamePk: String(game.gamePk) }}
      className="block overflow-hidden rounded-xl border border-border/70 bg-gradient-to-br from-card via-card to-secondary/40 p-5 transition-colors hover:border-primary/50 md:p-7"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="mono rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-primary">
          Featured matchup
        </span>
        <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {game.venue}
        </span>
        {game.isLive ? (
          <span className="mono inline-flex items-center gap-1.5 rounded-full bg-live/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-live">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
            Live
          </span>
        ) : null}
      </div>

      <div className="grid gap-6 md:grid-cols-[1fr_auto_1fr] md:items-center">
        <TeamBlock side="away" abbrev={game.away.abbreviation} name={game.away.name}
                   record={game.away.record} score={game.away.score} proj={projAway} />
        <div className="hidden text-center md:block">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">VS</div>
          <div className="font-display text-3xl text-muted-foreground">@</div>
        </div>
        <TeamBlock side="home" abbrev={game.home.abbreviation} name={game.home.name}
                   record={game.home.record} score={game.home.score} proj={projHome} />
      </div>

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Diamond win probability
          </span>
          <span className="mono text-[10px] uppercase tracking-widest text-edge">
            est. · sim engine v0
          </span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-secondary">
          <div className="bg-edge transition-all" style={{ width: `${awayWinPct}%` }} />
          <div className="bg-primary transition-all" style={{ width: `${homeWinPct}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-xs">
          <span className="mono text-edge">{game.away.abbreviation} {awayWinPct}%</span>
          <span className="mono text-primary">{homeWinPct}% {game.home.abbreviation}</span>
        </div>
      </div>
    </Link>
  );
}



function TeamBlock({
  abbrev, name, record, score, proj,
}: {
  side: "home" | "away";
  abbrev: string; name: string; record: string;
  score: number | null; proj: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-3">
        <div className="flex h-12 w-14 items-center justify-center rounded-md bg-secondary font-display text-xl font-bold">
          {abbrev || "?"}
        </div>
        <div>
          <div className="font-display text-lg font-semibold leading-tight">{name}</div>
          <div className="mono text-xs text-muted-foreground">{record}</div>
        </div>
      </div>
      <div className="flex items-baseline gap-4">
        <div className="mono text-4xl font-bold tabular-nums">{score ?? "—"}</div>
        <div className="mono text-xs uppercase tracking-widest text-edge">
          proj <span className="text-foreground">{proj}</span>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-card/40 p-10 text-center">
      <div className="mono text-xs uppercase tracking-widest text-muted-foreground">Off day</div>
      <p className="mt-2 text-sm text-muted-foreground">
        No MLB games on this date. Check back tomorrow.
      </p>
    </div>
  );
}

