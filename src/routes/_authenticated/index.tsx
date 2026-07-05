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
      { title: "Diamond Live — MLB Risers, Fallers & Live Intelligence" },
      {
        name: "description",
        content:
          "The daily front page of Major League Baseball. Verified hitter and pitcher movers, live slate, and lineup intelligence.",
      },
      { property: "og:title", content: "Diamond Live — MLB Risers & Fallers" },
      {
        property: "og:description",
        content: "The daily front page of Major League Baseball.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(moversQuery),
  errorComponent: ({ error, reset }) => (
    <div className="mx-auto max-w-3xl px-4 py-16 text-center">
      <h1 className="font-display text-3xl text-foreground">Rain delay.</h1>
      <p className="mt-2 text-sm text-muted-foreground">{String(error?.message ?? error)}</p>
      <button
        onClick={() => reset()}
        className="mono mt-6 rounded-sm border border-[var(--brass)] px-3 py-1.5 text-xs uppercase tracking-widest text-[var(--primary)] hover:text-[var(--cream)]"
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
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const fetchedAt = new Date(data.fetchedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      {/* Front-page masthead */}
      <header className="border-b border-[var(--border)] pb-5">
        <div className="mono flex items-center justify-between text-[10px] uppercase tracking-[0.24em] text-[var(--primary)]">
          <span>{today}</span>
          <span>
            <span className="mr-1 inline-block h-1.5 w-1.5 translate-y-[-1px] rounded-full bg-[var(--field)]" />
            Verified · Updated {fetchedAt}
          </span>
        </div>
        <h1 className="font-display mt-2 text-[40px] leading-[1.05] text-[var(--cream)] md:text-[64px]">
          MLB Risers &amp; Fallers
        </h1>
        <p className="mt-3 max-w-3xl text-sm text-[var(--warm-muted)] md:text-base">
          Verified game data only. Recent {data.window.hitter.recentDays}-day window
          {" "}({data.recentStartDate} → {data.recentEndDate}) against season-to-date.
          No projections, probabilities, or odds appear on this page.
        </p>
      </header>

      {/* Live slate strip */}
      <section className="mt-6">
        <div className="mb-2 flex items-baseline justify-between">
          <div className="eyebrow">Today&apos;s Slate</div>
          <Link to="/mlb-pulse" className="mono text-[10px] uppercase tracking-widest text-[var(--primary)] hover:text-[var(--cream)]">
            Open Pulse →
          </Link>
        </div>
        {pulse.data ? (
          <PulseStrip games={pulse.data.games} />
        ) : pulse.isLoading ? (
          <div className="mono text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
            Loading slate…
          </div>
        ) : (
          <div className="mono text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
            Slate unavailable.
          </div>
        )}
      </section>

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
        subtitle={`ERA and WHIP both improving · min ${data.window.pitcher.recentIpMin} recent IP (or ${data.window.pitcher.recentAppsWithIp}+ apps & ${data.window.pitcher.recentIpWithApps}+ IP), ${data.window.pitcher.seasonIp} season IP`}
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

      <footer className="mt-12 border-t border-[var(--border)] pt-4 text-center text-[10px] text-[var(--warm-muted)]">
        <span className="mono">
          Considered: {data.hitters.totalConsidered} hitters ({data.hitters.earlySample} early sample) ·{" "}
          {data.pitchers.totalConsidered} pitchers ({data.pitchers.earlySample} early sample) · Source: statsapi.mlb.com
        </span>
      </footer>
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
    <section className="mt-10">
      <div className="mb-3 flex items-end justify-between gap-3 border-b border-[var(--border)] pb-2">
        <div className="min-w-0">
          <h2 className="font-display text-[26px] leading-tight text-[var(--cream)] md:text-[32px]">
            {title}
          </h2>
          <p className="mono mt-0.5 text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
            {subtitle}
          </p>
        </div>
        <Link
          to={moreHref}
          className="mono whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[var(--primary)] hover:text-[var(--cream)]"
        >
          See all →
        </Link>
      </div>
      {items.length === 0 ? (
        <div className="rounded-sm border border-dashed border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_80%,transparent)] px-4 py-6 text-center text-xs text-[var(--warm-muted)]">
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
    return (
      <div className="mono text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
        No games on the slate today.
      </div>
    );
  }
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {games.slice(0, 16).map((g: any) => {
        const isLive = g.status === "live";
        return (
          <div
            key={g.gamePk ?? g.id}
            className={`min-w-[150px] rounded-sm border px-2.5 py-1.5 ${
              isLive
                ? "border-[var(--field)] bg-[color-mix(in_oklab,var(--field)_18%,transparent)]"
                : "border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_80%,transparent)]"
            }`}
          >
            <div className="mono flex items-center justify-between text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
              <span>{g.away?.abbreviation ?? "AWY"} @ {g.home?.abbreviation ?? "HME"}</span>
              {isLive ? (
                <span className="text-[var(--field)]">● Live</span>
              ) : (
                <span>{g.statusText ?? g.status ?? ""}</span>
              )}
            </div>
            {typeof g.away?.score === "number" && typeof g.home?.score === "number" ? (
              <div className="mono mt-1 text-[13px] font-bold text-[var(--cream)]">
                {g.away.score} — {g.home.score}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
