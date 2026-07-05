import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { getMlbMovers, type HitterMover, type PitcherMover } from "@/lib/movers.functions";
import { getMlbPulse } from "@/lib/pulse.functions";
import { HitterCard, PitcherCard } from "@/components/movers/mover-cards";

const moversQuery = queryOptions({
  queryKey: ["mlb-movers"],
  queryFn: () => getMlbMovers({ data: {} }),
  staleTime: 5 * 60_000,
  refetchOnWindowFocus: false,
});

const pulseQuery = queryOptions({
  queryKey: ["mlb-pulse", "home-strip"],
  queryFn: () => getMlbPulse({ data: {} }),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
});

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Diamond Live — MLB Risers & Fallers" },
      {
        name: "description",
        content:
          "See what is changing in baseball before it becomes the story. Live hitter and pitcher movers built from verified MLB game data.",
      },
      { property: "og:title", content: "Diamond Live — MLB Risers & Fallers" },
      {
        property: "og:description",
        content: "Live baseball intelligence — hitter and pitcher movers from verified MLB data.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(moversQuery),
  errorComponent: ({ error, reset }) => (
    <div className="mx-auto max-w-3xl px-4 py-16 text-center">
      <h1 className="text-xl font-semibold text-foreground">Movers unavailable</h1>
      <p className="mt-2 text-sm text-muted-foreground">{String(error?.message ?? error)}</p>
      <button
        onClick={() => reset()}
        className="mono mt-6 rounded border border-border px-3 py-1.5 text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground"
      >
        Retry
      </button>
    </div>
  ),
  notFoundComponent: () => <div className="p-8">Not found.</div>,
  component: DiamondLiveHome,
});

function DiamondLiveHome() {
  const { data } = useSuspenseQuery(moversQuery);
  const pulse = useQuery({ ...pulseQuery, throwOnError: false });

  return (
    <div className="relative min-h-screen bg-[radial-gradient(1200px_600px_at_50%_-200px,rgba(56,89,168,0.18),transparent_60%)]">
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
        <header className="mb-6 md:mb-8">
          <div className="mono text-[10px] uppercase tracking-[0.3em] text-primary/80">
            Diamond Live
          </div>
          <h1 className="mt-1 text-2xl font-semibold leading-tight text-foreground md:text-4xl">
            See what is changing in baseball
            <span className="text-muted-foreground"> before it becomes the story.</span>
          </h1>
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
            Verified MLB game data only. Recent {data.window.hitter.recentDays}-day window
            {" "}({data.recentStartDate} → {data.recentEndDate}) versus season-to-date. No
            projections, probabilities, or odds are used on this page.
          </p>
        </header>

        <MoverSection
          title="Hitter Risers"
          subtitle={`OPS trending up · min ${data.window.hitter.recentPa} recent PA, ${data.window.hitter.seasonPa} season PA`}
          items={data.hitters.risers}
          render={(m) => <HitterCard m={m as HitterMover} />}
          emptyLabel="No hitters meet riser criteria yet."
          moreHref="/hitters"
        />

        <MoverSection
          title="Hitter Fallers"
          subtitle="OPS trending down vs season"
          items={data.hitters.fallers}
          render={(m) => <HitterCard m={m as HitterMover} />}
          emptyLabel="No hitters meet faller criteria yet."
          moreHref="/hitters"
        />

        <MoverSection
          title="Pitcher Risers"
          subtitle={`ERA and WHIP both improving · min ${data.window.pitcher.recentIp} recent IP, ${data.window.pitcher.seasonIp} season IP`}
          items={data.pitchers.risers}
          render={(m) => <PitcherCard m={m as PitcherMover} />}
          emptyLabel="No pitchers meet riser criteria yet."
          moreHref="/pitchers"
        />

        <MoverSection
          title="Pitcher Fallers"
          subtitle="ERA and WHIP both regressing vs season"
          items={data.pitchers.fallers}
          render={(m) => <PitcherCard m={m as PitcherMover} />}
          emptyLabel="No pitchers meet faller criteria yet."
          moreHref="/pitchers"
        />

        <section className="mt-10">
          <div className="mb-3 flex items-baseline justify-between">
            <div>
              <h2 className="text-lg font-semibold text-foreground md:text-xl">Today's Pulse</h2>
              <p className="text-xs text-muted-foreground">
                Live slate with verified lineup labels.
              </p>
            </div>
            <Link to="/mlb-pulse" className="mono text-[10px] uppercase tracking-widest text-primary hover:text-primary/80">
              Open Pulse →
            </Link>
          </div>
          {pulse.data ? <PulseStrip games={pulse.data.games} /> : pulse.isLoading ? (
            <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Loading slate…</div>
          ) : (
            <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Slate unavailable.</div>
          )}
        </section>

        <footer className="mt-10 text-center text-[10px] text-muted-foreground/70">
          <span className="mono">
            Considered: {data.hitters.totalConsidered} hitters ({data.hitters.earlySample} early sample) ·{" "}
            {data.pitchers.totalConsidered} pitchers ({data.pitchers.earlySample} early sample). Source: statsapi.mlb.com. Fetched{" "}
            {new Date(data.fetchedAt).toLocaleTimeString()}.
          </span>
        </footer>
      </div>
    </div>
  );
}

function MoverSection<T extends { mlbId: number }>({
  title,
  subtitle,
  items,
  render,
  emptyLabel,
  moreHref,
}: {
  title: string;
  subtitle: string;
  items: T[];
  render: (item: T) => React.ReactNode;
  emptyLabel: string;
  moreHref: string;
}) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground md:text-xl">{title}</h2>
          <p className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{subtitle}</p>
        </div>
        <Link
          to={moreHref}
          className="mono whitespace-nowrap text-[10px] uppercase tracking-widest text-primary hover:text-primary/80"
        >
          See all →
        </Link>
      </div>
      {items.length === 0 ? (
        <div className="rounded border border-dashed border-border/60 bg-black/20 px-4 py-6 text-center text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.slice(0, 8).map((it) => (
            <div key={it.mlbId}>{render(it)}</div>
          ))}
        </div>
      )}
    </section>
  );
}

function PulseStrip({ games }: { games: any[] }) {
  if (!games?.length) {
    return <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">No games on the slate today.</div>;
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {games.slice(0, 12).map((g: any) => (
        <div key={g.gamePk} className="rounded border border-border/60 bg-black/30 px-3 py-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-foreground">
              {g.away?.abbreviation ?? "AWY"} @ {g.home?.abbreviation ?? "HME"}
            </span>
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {g.statusText ?? g.status ?? ""}
            </span>
          </div>
          {typeof g.away?.score === "number" && typeof g.home?.score === "number" ? (
            <div className="mono mt-1 text-[11px] text-muted-foreground">
              {g.away.score} — {g.home.score}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
