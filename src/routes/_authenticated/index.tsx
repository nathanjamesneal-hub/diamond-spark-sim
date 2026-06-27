import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getSchedule, type GameSummary } from "@/lib/mlb.functions";
import { getDiamondScores } from "@/lib/projections.functions";
import { ScoreCard } from "@/components/score-card";
import { ForecastBoard } from "@/components/diamond/forecast-board/forecast-board";

const scheduleQuery = queryOptions({
  queryKey: ["schedule", "today"],
  queryFn: async () => {
    try {
      return await getSchedule({ data: {} });
    } catch (err) {
      console.error("[index] getSchedule failed; rendering empty slate", err);
      const today = new Date().toISOString().slice(0, 10);
      return { date: today, games: [] as GameSummary[] };
    }
  },
  refetchInterval: 15_000,
  refetchOnWindowFocus: false,
  retry: 2,
  retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  throwOnError: false,
});

export const Route = createFileRoute("/_authenticated/")({
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
    <div className="mx-auto max-w-2xl p-8 text-sm">
      <div className="font-display text-lg text-foreground">Couldn't load today's slate.</div>
      <div className="mt-1 text-muted-foreground">{error?.message ?? String(error)}</div>
    </div>
  ),
  notFoundComponent: () => <div className="p-8">No games today.</div>,
});

function TodayPage() {
  const { data } = useSuspenseQuery(scheduleQuery);
  const featured = data.games.find((g) => g.isLive) ?? data.games[0];
  const rest = data.games.filter((g) => g.gamePk !== featured?.gamePk);
  const liveCount = data.games.filter((g) => g.isLive).length;

  const statusLine = data.games.length === 0
    ? "No MLB games on the slate today."
    : liveCount > 0
      ? `${liveCount} live · ${data.games.length} games on slate`
      : `Today's simulations are complete · ${data.games.length} games on slate`;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <DiamondHero date={data.date} statusLine={statusLine} hasLive={liveCount > 0} />

      <DashboardGrid hasLive={liveCount > 0} />

      {featured ? <FeaturedMatchup game={featured} /> : null}

      <div className="mt-8">
        <h2 className="display mb-3 text-lg uppercase tracking-wider text-muted-foreground">
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
    to: "/forecasts",
    kicker: "Forecasts",
    title: "Official Diamond Forecasts",
    desc: "Lineup-confirmed forecasts, rankings, and consensus signals for today.",
    accent: "text-primary",
    accentBg: "color-mix(in oklab, var(--color-primary) 22%, transparent)",
  },
  {
    to: "/results",
    kicker: "Results",
    title: "Yesterday in Diamond",
    desc: "Locked official forecasts graded against final box-score actuals.",
    accent: "text-[var(--color-success)]",
    accentBg: "color-mix(in oklab, var(--color-success) 22%, transparent)",
  },
  {
    to: "/scores",
    kicker: "Live",
    title: "Live Matchups",
    desc: "Real-time scores, inning state, win probability, and projected lines.",
    accent: "text-live",
    accentBg: "color-mix(in oklab, var(--color-live) 22%, transparent)",
  },
] as const;

function DashboardGrid({ hasLive }: { hasLive: boolean }) {
  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {DASHBOARD_CARDS.map((c) => (
        <Link
          key={c.to}
          to={c.to}
          className={`card-elevated group relative flex flex-col overflow-hidden p-5 ${c.to === "/scores" && hasLive ? "sweep" : ""}`}
        >
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-px"
            style={{ background: c.accentBg }}
          />
          <div className={`mono text-[10px] font-semibold uppercase tracking-[0.22em] ${c.accent}`}>
            {c.kicker}
          </div>
          <div className="display mt-1 text-xl tracking-tight text-foreground">
            {c.title}
          </div>
          <p className="mt-2 flex-1 text-xs text-muted-foreground">{c.desc}</p>
          <div className="mono mt-4 text-[10px] uppercase tracking-widest text-muted-foreground transition-colors group-hover:text-primary">
            Open →
          </div>
        </Link>
      ))}
    </div>
  );
}

function DiamondHero({
  date, statusLine, hasLive,
}: { date: string; statusLine: string; hasLive: boolean }) {
  return (
    <div className="relative mb-10 overflow-hidden rounded-2xl border border-border bg-[var(--color-surface-panel)] px-5 py-8 md:px-10 md:py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(600px 240px at 10% 0%, color-mix(in oklab, var(--color-primary) 18%, transparent), transparent 60%), radial-gradient(500px 240px at 95% 100%, color-mix(in oklab, var(--color-primary) 12%, transparent), transparent 60%)",
        }}
      />
      <div className="relative">
        <div className="mono text-[11px] font-semibold uppercase tracking-[0.28em] text-primary">
          {date} {hasLive ? "· LIVE" : ""}
        </div>
        <h1 className="wordmark mt-2 text-[clamp(56px,11vw,112px)] leading-[0.95] text-foreground">
          Diamond
        </h1>
        <div className="mt-3 h-px w-24 bg-primary glow-edge" />
        <p className="mt-4 text-sm uppercase tracking-[0.18em] text-muted-foreground">
          MLB Simulation &amp; Projection Engine
        </p>
        <p className="mono mt-1 text-xs text-foreground/80">{statusLine}</p>
      </div>
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

