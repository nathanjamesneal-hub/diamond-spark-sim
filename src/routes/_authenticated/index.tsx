import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { getMlbMovers } from "@/lib/movers.functions";
import { getMlbPulse, type PulseGame } from "@/lib/pulse.functions";
import { supabase } from "@/integrations/supabase/client";
import { todayInAppTz, formatTimeInAppTz } from "@/lib/timezone";
import { getEngineBetaDataHealth } from "@/lib/engine-beta/health.functions";

const moversQuery = queryOptions({
  queryKey: ["mlb-movers"],
  queryFn: () => getMlbMovers({ data: {} }),
  staleTime: 5 * 60_000,
  refetchOnWindowFocus: false,
});

const pulseQuery = queryOptions({
  queryKey: ["mlb-pulse", "home"],
  queryFn: () => getMlbPulse({ data: {} }),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
});

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Diamond — Today in Baseball" },
      {
        name: "description",
        content:
          "Diamond home: today's MLB slate at a glance, top movers, and quick access to Pulse, Explore, Hitters, Pitchers, and your Watchlist.",
      },
      { property: "og:title", content: "Diamond — Today in Baseball" },
      {
        property: "og:description",
        content: "Today's MLB slate at a glance. Pick where to dig deeper.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(moversQuery),
  errorComponent: ({ error, reset }) => (
    <div className="mx-auto max-w-3xl px-4 py-16 text-center">
      <h1 className="text-3xl text-foreground">Rain delay.</h1>
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
  component: DiamondHome,
});

function useFirstName(): string | null {
  const q = useQuery({
    queryKey: ["home", "me", "first-name"],
    queryFn: async () => {
      const { data } = await supabase.auth.getUser();
      const u = data.user;
      if (!u) return null;
      const md: any = u.user_metadata ?? {};
      const raw =
        md.first_name ||
        md.given_name ||
        md.full_name ||
        md.name ||
        (u.email ? u.email.split("@")[0] : null);
      if (!raw || typeof raw !== "string") return null;
      const first = raw.trim().split(/\s+/)[0];
      if (!first) return null;
      return first.length <= 40 ? first : null;
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  return q.data ?? null;
}

function useIsAdmin(): boolean {
  const q = useQuery({
    queryKey: ["home", "is-admin"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const uid = userRes.user?.id;
      if (!uid) return false;
      const { data, error } = await supabase.rpc("has_role", { _user_id: uid, _role: "admin" });
      if (error) return false;
      return !!data;
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  return !!q.data;
}

function DiamondHome() {
  const { data: movers } = useSuspenseQuery(moversQuery);
  const pulse = useQuery({ ...pulseQuery, throwOnError: false });
  const firstName = useFirstName();
  const isAdmin = useIsAdmin();

  const slateDate = todayInAppTz();
  const dateLabel = new Date(slateDate + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  });

  const games = pulse.data?.games ?? [];
  const liveCount = games.filter((g) => g.status === "live").length;
  const upcomingCount = games.filter((g) => g.status === "upcoming" || g.status === "delayed").length;
  const finalCount = games.filter((g) => g.status === "final").length;
  const officialLineups = games.filter(
    (g) =>
      g.lineupState?.away?.label === "Official" || g.lineupState?.home?.label === "Official",
  ).length;
  const gamesToday = games.length;

  let slateSentence = "";
  if (!pulse.data) {
    slateSentence = "Loading today's slate…";
  } else if (gamesToday === 0) {
    slateSentence = "No MLB games on today's slate.";
  } else if (liveCount > 0) {
    slateSentence = `MLB is live · ${liveCount} game${liveCount === 1 ? "" : "s"} in progress.`;
  } else if (finalCount === gamesToday) {
    slateSentence = "Today's slate is final.";
  } else {
    slateSentence = `${gamesToday} game${gamesToday === 1 ? "" : "s"} on today's slate.`;
  }

  // Preview: live first, then upcoming, then final — cap at 3
  const previewGames = [
    ...games.filter((g) => g.status === "live"),
    ...games.filter((g) => g.status === "upcoming" || g.status === "delayed"),
    ...games.filter((g) => g.status === "final"),
  ].slice(0, 3);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
      {/* Compact welcome */}
      <header className="glass-panel relative overflow-hidden px-5 py-5 md:px-7 md:py-6">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-20 -right-12 h-48 w-48 rounded-full bg-[color-mix(in_oklab,var(--brass)_28%,transparent)] blur-3xl"
        />
        <div className="relative">
          <div className="mono flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.28em] text-[var(--primary)]">
            <span>{dateLabel}</span>
            {liveCount > 0 && (
              <span className="inline-flex items-center gap-2 text-[var(--brass)]">
                <span className="live-dot" />
                <span>Live</span>
              </span>
            )}
          </div>
          <h1 className="mt-2 bg-gradient-to-br from-[var(--cream)] via-[var(--primary-glow)] to-[var(--brass)] bg-clip-text text-[26px] leading-[1.1] text-transparent md:text-[36px]">
            {firstName ? `Welcome back, ${firstName}.` : "Welcome to Diamond."}
          </h1>
          <p className="mt-1.5 text-sm text-[var(--parchment)]">{slateSentence}</p>
          <div className="mt-4 flex flex-wrap gap-1.5">
            <ChipLink to="/mlb-pulse" label="Games" value={pulse.data ? String(gamesToday) : "—"} />
            <ChipLink
              to="/mlb-pulse"
              label="Live"
              value={pulse.data ? String(liveCount) : "—"}
              accent={liveCount > 0 ? "live" : undefined}
            />
            <ChipLink to="/mlb-pulse" label="Upcoming" value={pulse.data ? String(upcomingCount) : "—"} />
            <ChipLink to="/mlb-pulse" label="Final" value={pulse.data ? String(finalCount) : "—"} />
            <ChipLink
              to="/mlb-pulse"
              label="Official Lineups"
              value={pulse.data ? String(officialLineups) : "—"}
            />
          </div>
        </div>
      </header>

      {/* Today in Diamond — 3 cards max */}
      <TodayInDiamond movers={movers} games={games} loading={!pulse.data && pulse.isLoading} />

      {/* Open Diamond — nav grid */}
      <section className="mt-8">
        <SectionHeader title="Open Diamond" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <RouteCard to="/explore" title="Explore MLB" desc="Rank, filter, and search the league." />
          <RouteCard to="/mlb-pulse" title="Live Pulse" desc="Games, lineups, and live activity." />
          <RouteCard to="/hitters" title="Hitters Moving" desc="Recent hitter form." />
          <RouteCard to="/pitchers" title="Pitchers Moving" desc="Arms trending up or down." />
          <RouteCard to="/watchlist" title="Watchlist" desc="Saved players and teams." />
          {isAdmin && (
            <RouteCard
              to="/engine-beta"
              title="Engine Beta"
              desc="Private research board."
              admin
            />
          )}
        </div>
      </section>

      {/* Small slate preview */}
      <section className="mt-8">
        <SectionHeaderLink to="/mlb-pulse" title="Today's Games" cta="View Full Slate" />
        {pulse.data ? (
          previewGames.length === 0 ? (
            <EmptyLine>No MLB games on today's slate.</EmptyLine>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {previewGames.map((g) => (
                <GameTile key={g.id} game={g} />
              ))}
            </div>
          )
        ) : pulse.isLoading ? (
          <EmptyLine>Loading games…</EmptyLine>
        ) : (
          <EmptyLine>Slate unavailable.</EmptyLine>
        )}
      </section>

      {/* Engine Beta thin status (admin only) */}
      {isAdmin && <EngineBetaStatusStrip />}

      <footer className="mt-10 border-t border-[var(--border)] pt-4 text-center text-[10px] text-[var(--warm-muted)]">
        <span className="mono">
          Slate {slateDate} · America/Chicago · Source: statsapi.mlb.com
        </span>
      </footer>
    </div>
  );
}

// ---------------- Sub-components ----------------

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="mb-3 border-b border-[var(--border)] pb-2">
      <h2 className="text-[18px] leading-tight text-[var(--cream)] md:text-[22px]">{title}</h2>
    </div>
  );
}

function SectionHeaderLink({ to, title, cta }: { to: string; title: string; cta: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3 border-b border-[var(--border)] pb-2">
      <Link
        to={to}
        className="group inline-flex items-baseline gap-2 text-[18px] leading-tight text-[var(--cream)] hover:text-[var(--primary-glow)] md:text-[22px]"
      >
        <span>{title}</span>
        <span className="mono text-[10px] uppercase tracking-widest text-[var(--primary)] opacity-70 group-hover:opacity-100">
          Open →
        </span>
      </Link>
      <Link
        to={to}
        className="mono whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[var(--primary)] hover:text-[var(--cream)]"
      >
        {cta} →
      </Link>
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-sm border border-dashed border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_80%,transparent)] px-4 py-6 text-center text-xs text-[var(--warm-muted)]">
      {children}
    </div>
  );
}

function ChipLink({
  to,
  label,
  value,
  accent,
}: {
  to: string;
  label: string;
  value: string;
  accent?: "live";
}) {
  const cls =
    accent === "live"
      ? "border-[color-mix(in_oklab,var(--brass)_60%,transparent)] bg-[color-mix(in_oklab,var(--brass)_10%,var(--charcoal))] shadow-[0_0_18px_color-mix(in_oklab,var(--brass)_25%,transparent)]"
      : "border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_75%,transparent)] hover:border-[color-mix(in_oklab,var(--brass)_45%,var(--border))]";
  return (
    <Link
      to={to}
      className={`inline-flex items-center rounded-full border px-2.5 py-1 transition-colors ${cls}`}
    >
      <span className="mono text-[9px] uppercase tracking-widest text-[var(--warm-muted)]">
        {label}
      </span>
      <span className="mono ml-1.5 text-[11px] font-bold text-[var(--cream)]">{value}</span>
    </Link>
  );
}

function RouteCard({
  to,
  title,
  desc,
  admin,
}: {
  to: string;
  title: string;
  desc: string;
  admin?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`group block rounded-md border px-4 py-3.5 backdrop-blur-sm transition-all ${
        admin
          ? "border-[color-mix(in_oklab,var(--violet-glow)_50%,transparent)] bg-[color-mix(in_oklab,var(--violet-glow)_8%,var(--charcoal))] hover:border-[var(--violet-glow)]"
          : "border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_80%,transparent)] hover:border-[color-mix(in_oklab,var(--brass)_45%,var(--border))]"
      }`}
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-[15px] font-semibold text-[var(--cream)] md:text-[16px]">{title}</h3>
        {admin && (
          <span className="mono rounded-sm border border-[color-mix(in_oklab,var(--violet-glow)_60%,transparent)] px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-[var(--violet-glow)]">
            Admin
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[11px] text-[var(--parchment)] md:text-xs">{desc}</p>
      <div className="mono mt-2 text-[10px] uppercase tracking-widest text-[var(--primary)] group-hover:text-[var(--cream)]">
        Open →
      </div>
    </Link>
  );
}

function GameTile({ game: g }: { game: PulseGame }) {
  const isLive = g.status === "live";
  const isFinal = g.status === "final";
  const firstPitch = g.firstPitch ? formatTimeInAppTz(g.firstPitch) : null;

  const statusLabel = isLive
    ? g.inning
      ? `${g.inningHalf ?? ""} ${g.inning}`.trim()
      : "Live"
    : isFinal
    ? "Final"
    : firstPitch ?? g.statusText ?? "Scheduled";

  if (!g.gamePk) {
    return (
      <div className="block rounded-md border border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_80%,transparent)] px-3 py-3 opacity-70">
        <div className="mono text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
          {g.away?.abbreviation ?? "AWY"} @ {g.home?.abbreviation ?? "HME"}
        </div>
        <div className="mono mt-1.5 text-[13px] text-[var(--warm-muted)]">Unavailable</div>
      </div>
    );
  }
  return (
    <Link
      to="/game/$gamePk"
      params={{ gamePk: String(g.gamePk) }}
      className={`block rounded-md border px-3 py-3 backdrop-blur-sm transition-colors ${
        isLive
          ? "border-[color-mix(in_oklab,var(--brass)_60%,transparent)] bg-[color-mix(in_oklab,var(--brass)_10%,var(--charcoal))] shadow-[0_0_18px_color-mix(in_oklab,var(--brass)_25%,transparent)]"
          : "border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_80%,transparent)] hover:border-[color-mix(in_oklab,var(--brass)_35%,var(--border))]"
      }`}
    >
      <div className="mono flex items-center justify-between text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
        <span className="text-[var(--parchment)]">
          {g.away?.abbreviation ?? "AWY"} @ {g.home?.abbreviation ?? "HME"}
        </span>
        {isLive ? (
          <span className="inline-flex items-center gap-1.5 text-[var(--brass)]">
            <span className="live-dot" />
            {statusLabel}
          </span>
        ) : (
          <span>{statusLabel}</span>
        )}
      </div>
      {typeof g.away?.score === "number" && typeof g.home?.score === "number" ? (
        <div className="mono mt-1.5 text-[16px] font-bold text-[var(--cream)]">
          {g.away.score} <span className="text-[var(--warm-muted)]">—</span> {g.home.score}
        </div>
      ) : (
        <div className="mono mt-1.5 text-[13px] font-semibold text-[var(--cream)]">
          {firstPitch ?? "TBD"}
        </div>
      )}
    </Link>
  );
}

function TodayInDiamond({
  movers,
  games,
  loading,
}: {
  movers: Awaited<ReturnType<typeof getMlbMovers>>;
  games: PulseGame[];
  loading: boolean;
}) {
  const topHitter = movers.hitters.risers[0] ?? null;
  const topPitcher = movers.pitchers.risers[0] ?? null;

  const keystone =
    games.find((g) => g.status === "live" && g.lineupState?.away?.label === "Official") ??
    games.find((g) => g.status === "live") ??
    games.find(
      (g) =>
        (g.status === "upcoming" || g.status === "delayed") &&
        (g.lineupState?.away?.label === "Official" || g.lineupState?.home?.label === "Official"),
    ) ??
    games.find((g) => g.status === "upcoming") ??
    null;

  const cards: React.ReactNode[] = [];
  if (topHitter) {
    cards.push(
      <TodayCard
        key="hitter"
        eyebrow="Top Hitter Mover"
        title={topHitter.name}
        sub={topHitter.team ?? ""}
        body="14-day form rising."
        to="/player/$mlbId"
        params={{ mlbId: String(topHitter.mlbId) }}
        cta="Open Player"
        tone="riser"
      />,
    );
  }
  if (topPitcher) {
    cards.push(
      <TodayCard
        key="pitcher"
        eyebrow="Top Pitcher Mover"
        title={topPitcher.name}
        sub={topPitcher.team ?? ""}
        body="ERA & WHIP improving."
        to="/player/$mlbId"
        params={{ mlbId: String(topPitcher.mlbId) }}
        cta="Open Player"
        tone="riser"
      />,
    );
  }
  if (keystone && keystone.gamePk) {
    const stateLine =
      keystone.status === "live"
        ? keystone.inning
          ? `Live · ${keystone.inningHalf ?? ""} ${keystone.inning}`.trim()
          : "Live now."
        : keystone.firstPitch
        ? `First pitch ${formatTimeInAppTz(keystone.firstPitch)}.`
        : "First pitch TBD.";
    cards.push(
      <TodayCard
        key="matchup"
        eyebrow="Matchup to Watch"
        title={`${keystone.away?.abbreviation ?? "AWY"} @ ${keystone.home?.abbreviation ?? "HME"}`}
        sub={keystone.venue ?? ""}
        body={stateLine}
        to="/game/$gamePk"
        params={{ gamePk: String(keystone.gamePk) }}
        cta="Open Game"
        tone={keystone.status === "live" ? "live" : "neutral"}
      />,
    );
  }

  if (cards.length === 0 && !loading) return null;

  return (
    <section className="mt-6">
      <SectionHeader title="Today in Diamond" />
      {loading && cards.length === 0 ? (
        <EmptyLine>Gathering today's storylines…</EmptyLine>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">{cards}</div>
      )}
    </section>
  );
}

function TodayCard({
  eyebrow,
  title,
  sub,
  body,
  to,
  params,
  cta,
  tone,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  body: string;
  to: any;
  params?: any;
  cta: string;
  tone: "riser" | "live" | "neutral";
}) {
  const toneCls =
    tone === "live"
      ? "border-[color-mix(in_oklab,var(--brass)_60%,transparent)] bg-[color-mix(in_oklab,var(--brass)_10%,var(--charcoal))] shadow-[0_0_22px_color-mix(in_oklab,var(--brass)_25%,transparent)]"
      : tone === "riser"
      ? "border-[color-mix(in_oklab,var(--field)_45%,transparent)] bg-[color-mix(in_oklab,var(--field)_8%,var(--charcoal))]"
      : "border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_82%,transparent)]";
  return (
    <Link
      to={to}
      params={params}
      className={`group block rounded-md border px-3.5 py-3.5 backdrop-blur-sm transition-all hover:border-[color-mix(in_oklab,var(--brass)_55%,var(--border))] ${toneCls}`}
    >
      <div className="mono text-[9px] uppercase tracking-[0.22em] text-[var(--primary)]">
        {eyebrow}
      </div>
      <div className="mt-1 text-[16px] font-semibold text-[var(--cream)] md:text-[17px]">
        {title}
      </div>
      {sub && (
        <div className="mono text-[9px] uppercase tracking-widest text-[var(--warm-muted)]">
          {sub}
        </div>
      )}
      <p className="mt-1.5 text-[11px] text-[var(--parchment)] md:text-xs">{body}</p>
      <div className="mono mt-2 text-[10px] uppercase tracking-widest text-[var(--primary)] group-hover:text-[var(--cream)]">
        {cta} →
      </div>
    </Link>
  );
}

function EngineBetaStatusStrip() {
  const q = useQuery({
    queryKey: ["home", "engine-beta-health"],
    queryFn: () => getEngineBetaDataHealth({ data: {} }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (q.isError) return null;

  const cards = q.data?.cards ?? [];
  const forecast = cards.find((c) => c.key === "baseline_forecast" || c.key === "forecast");
  const autolock = cards.find((c) => c.key === "autolock");
  const lineups = cards.find((c) => c.key === "lineups");
  const schedule = cards.find((c) => c.key === "schedule");

  let headline = "Board Ready";
  let tone: "ready" | "warn" | "bad" = "ready";
  if (!q.data) {
    headline = "Loading…";
    tone = "warn";
  } else if (schedule?.status === "missing" || cards.some((c) => c.status === "failed")) {
    headline = "Incomplete";
    tone = "bad";
  } else if (
    autolock &&
    autolock.detail &&
    autolock.detail.includes("missed") &&
    autolock.detail.match(/(\d+) missed/)?.[1] !== "0"
  ) {
    headline = "Games Locking";
    tone = "warn";
  } else if (lineups?.status === "delayed" || lineups?.status === "not_expected_yet") {
    headline = "Awaiting Lineups";
    tone = "warn";
  } else if (cards.some((c) => c.status === "delayed")) {
    headline = "Locked / Grading";
    tone = "warn";
  }

  const toneCls =
    tone === "ready"
      ? "border-[color-mix(in_oklab,var(--field)_45%,transparent)]"
      : tone === "warn"
      ? "border-[color-mix(in_oklab,var(--brass)_50%,transparent)]"
      : "border-[color-mix(in_oklab,var(--cardinal)_55%,transparent)]";

  return (
    <section className="mt-8">
      <Link
        to="/engine-beta"
        className={`block rounded-md border bg-[color-mix(in_oklab,var(--violet-glow)_6%,var(--charcoal))] px-3.5 py-2.5 transition-colors hover:border-[var(--violet-glow)] ${toneCls}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <span className="mono text-[9px] uppercase tracking-[0.22em] text-[var(--violet-glow)]">
              Engine Beta · Admin
            </span>
            <span className="mono text-[11px] font-semibold text-[var(--cream)]">{headline}</span>
            {forecast?.latestAt && (
              <span className="mono hidden text-[10px] uppercase tracking-widest text-[var(--warm-muted)] sm:inline">
                Forecast · {formatTimeInAppTz(forecast.latestAt)}
              </span>
            )}
          </div>
          <span className="mono text-[10px] uppercase tracking-widest text-[var(--primary)]">
            Open →
          </span>
        </div>
      </Link>
    </section>
  );
}
