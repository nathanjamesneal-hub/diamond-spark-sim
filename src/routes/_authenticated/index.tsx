import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { getMlbMovers, type HitterMover, type PitcherMover } from "@/lib/movers.functions";
import { getMlbPulse, type PulseGame } from "@/lib/pulse.functions";
import { HitterCard, PitcherCard } from "@/components/movers/mover-cards";
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
      { title: "Diamond — Your Daily MLB Command Center" },
      {
        name: "description",
        content:
          "Welcome back to Diamond. Today's MLB slate, live pulse, official lineups, and verified hitter and pitcher form movement — all in one place.",
      },
      { property: "og:title", content: "Diamond — Daily MLB Command Center" },
      {
        property: "og:description",
        content: "Today's MLB slate, live pulse, and verified movers.",
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
      // Capitalize gently only if it looks like an email-local plain lowercase word
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
    slateSentence = "No MLB games on today's slate";
  } else if (liveCount > 0) {
    slateSentence = `MLB is live · ${liveCount} game${liveCount === 1 ? "" : "s"} in progress`;
  } else if (finalCount === gamesToday) {
    slateSentence = "Today's slate is final";
  } else {
    slateSentence = `${gamesToday} game${gamesToday === 1 ? "" : "s"} on today's slate`;
  }

  const lastRefresh = pulse.data?.overallUpdatedAt
    ? formatTimeInAppTz(pulse.data.overallUpdatedAt)
    : null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      {/* Personal welcome */}
      <header className="glass-panel relative overflow-hidden px-5 py-7 md:px-8 md:py-9">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full bg-[color-mix(in_oklab,var(--brass)_35%,transparent)] blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-28 -left-16 h-64 w-64 rounded-full bg-[color-mix(in_oklab,var(--violet-glow)_25%,transparent)] blur-3xl"
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
          <h1 className="mt-3 bg-gradient-to-br from-[var(--cream)] via-[var(--primary-glow)] to-[var(--brass)] bg-clip-text text-[36px] leading-[1.05] text-transparent md:text-[56px]">
            {firstName ? `Welcome back, ${firstName}.` : "Welcome to Diamond."}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-[var(--parchment)] md:text-base">
            {slateSentence}
          </p>
        </div>
      </header>

      {/* Slate status chips */}
      <section className="mt-4">
        <div className="flex flex-wrap gap-2">
          <ChipLink to="/mlb-pulse" label="Games today" value={pulse.data ? String(gamesToday) : "—"} />
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
            label="Official lineups"
            value={pulse.data ? String(officialLineups) : "—"}
          />
          {lastRefresh && <Chip label="Last refresh" value={lastRefresh} />}
        </div>
      </section>

      {/* Today in Diamond hero panel */}
      <TodayInDiamond
        movers={movers}
        games={games}
        loading={!pulse.data && pulse.isLoading}
      />

      {/* Start exploring */}
      <section className="mt-8">
        <SectionHeader title="Start Exploring" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <RouteCard to="/explore" title="Explore MLB" desc="Rank, filter, and search the league." />
          <RouteCard to="/mlb-pulse" title="Live Pulse" desc="Every game, lineup, and live state." />
          <RouteCard to="/hitters" title="Hitters Moving" desc="Recent hitter form across MLB." />
          <RouteCard to="/pitchers" title="Pitchers Moving" desc="Arms trending up or down." />
          <RouteCard to="/watchlist" title="Watchlist" desc="Your saved players and teams." />
          {isAdmin && (
            <RouteCard
              to="/engine-beta"
              title="Diamond Engine Beta"
              desc="Private experimental research board."
              admin
            />
          )}
        </div>
      </section>

      {/* Today's Games */}
      <section className="mt-10">
        <div className="mb-3 flex items-end justify-between gap-3 border-b border-[var(--border)] pb-2">
          <SectionHeader title="Today's Games" inline />
          <Link
            to="/mlb-pulse"
            className="mono whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[var(--primary)] hover:text-[var(--cream)]"
          >
            Open Full Pulse →
          </Link>
        </div>
        {pulse.data ? (
          games.length === 0 ? (
            <EmptyLine>No MLB games on today's slate.</EmptyLine>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {games.map((g) => (
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

      {/* Movers That Matter */}
      <section className="mt-12">
        <SectionHeader title="Hitters Moving" />
        <MoverGrid
          risers={movers.hitters.risers.slice(0, 5)}
          fallers={movers.hitters.fallers.slice(0, 5)}
          renderRiser={(m) => <HitterCard m={m as HitterMover} />}
          renderFaller={(m) => <HitterCard m={m as HitterMover} />}
          emptyRisers="No hitter risers yet."
          emptyFallers="No hitter fallers yet."
        />
        <div className="mt-3">
          <Link
            to="/hitters"
            className="mono text-[10px] font-bold uppercase tracking-widest text-[var(--primary)] hover:text-[var(--cream)]"
          >
            View All Hitters →
          </Link>
        </div>
      </section>

      <section className="mt-10">
        <SectionHeader title="Pitchers Moving" />
        <MoverGrid
          risers={movers.pitchers.risers.slice(0, 5)}
          fallers={movers.pitchers.fallers.slice(0, 5)}
          renderRiser={(m) => <PitcherCard m={m as PitcherMover} />}
          renderFaller={(m) => <PitcherCard m={m as PitcherMover} />}
          emptyRisers="No pitcher risers yet."
          emptyFallers="No pitcher fallers yet."
        />
        <div className="mt-3">
          <Link
            to="/pitchers"
            className="mono text-[10px] font-bold uppercase tracking-widest text-[var(--primary)] hover:text-[var(--cream)]"
          >
            View All Pitchers →
          </Link>
        </div>
      </section>

      {/* Engine Beta status (admin only) */}
      {isAdmin && <EngineBetaStatusPanel />}

      <footer className="mt-12 border-t border-[var(--border)] pt-4 text-center text-[10px] text-[var(--warm-muted)]">
        <span className="mono">
          Slate {slateDate} · America/Chicago · Source: statsapi.mlb.com
        </span>
      </footer>
    </div>
  );
}

// ---------------- Sub-components ----------------

function SectionHeader({ title, inline = false }: { title: string; inline?: boolean }) {
  if (inline) {
    return (
      <h2 className="text-[22px] leading-tight text-[var(--cream)] md:text-[28px]">{title}</h2>
    );
  }
  return (
    <div className="mb-3 border-b border-[var(--border)] pb-2">
      <h2 className="text-[22px] leading-tight text-[var(--cream)] md:text-[28px]">{title}</h2>
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

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-full border border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_75%,transparent)] px-3 py-1.5">
      <span className="mono text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
        {label}
      </span>
      <span className="mono ml-2 text-[11px] font-bold text-[var(--cream)]">{value}</span>
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
      className={`inline-flex items-center rounded-full border px-3 py-1.5 transition-colors ${cls}`}
    >
      <span className="mono text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
        {label}
      </span>
      <span className="mono ml-2 text-[11px] font-bold text-[var(--cream)]">{value}</span>
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
      className={`group block rounded-md border px-4 py-4 backdrop-blur-sm transition-all ${
        admin
          ? "border-[color-mix(in_oklab,var(--violet-glow)_50%,transparent)] bg-[color-mix(in_oklab,var(--violet-glow)_8%,var(--charcoal))] hover:border-[var(--violet-glow)]"
          : "border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_80%,transparent)] hover:border-[color-mix(in_oklab,var(--brass)_45%,var(--border))]"
      }`}
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-[16px] font-semibold text-[var(--cream)] md:text-[18px]">{title}</h3>
        {admin && (
          <span className="mono rounded-sm border border-[color-mix(in_oklab,var(--violet-glow)_60%,transparent)] px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-[var(--violet-glow)]">
            Admin
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-[var(--parchment)] md:text-sm">{desc}</p>
      <div className="mono mt-3 text-[10px] uppercase tracking-widest text-[var(--primary)] group-hover:text-[var(--cream)]">
        Open →
      </div>
    </Link>
  );
}

function GameTile({ game: g }: { game: PulseGame }) {
  const isLive = g.status === "live";
  const isFinal = g.status === "final";
  const lineupOfficial =
    g.lineupState?.away?.label === "Official" || g.lineupState?.home?.label === "Official";
  const firstPitch = g.firstPitch ? formatTimeInAppTz(g.firstPitch) : null;

  const statusLabel = isLive
    ? g.inning
      ? `${g.inningHalf ?? ""} ${g.inning}`.trim()
      : "Live"
    : isFinal
    ? "Final"
    : firstPitch ?? g.statusText ?? "Scheduled";

  return (
    <Link
      to="/game/$gamePk"
      params={{ gamePk: String(g.gamePk ?? "") }}
      disabled={!g.gamePk}
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
      {lineupOfficial && (
        <div className="mono mt-2 text-[9px] uppercase tracking-widest text-[color-mix(in_oklab,var(--brass)_80%,var(--cream))]">
          Official lineup
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

  // Pick a keystone matchup: prefer live w/ official lineup, else upcoming with official lineup, else first upcoming
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
        body="14-day form is rising."
        to="/player/$mlbId"
        params={{ mlbId: String(topHitter.mlbId) }}
        cta="Open Player Hub"
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
        body="ERA & WHIP both improving over 14 days."
        to="/player/$mlbId"
        params={{ mlbId: String(topPitcher.mlbId) }}
        cta="Open Player Hub"
        tone="riser"
      />,
    );
  }
  if (keystone) {
    const lineupNote =
      keystone.lineupState?.away?.label === "Official" ||
      keystone.lineupState?.home?.label === "Official"
        ? "Official lineup confirmed."
        : "Lineup not yet official.";
    const stateLine =
      keystone.status === "live"
        ? keystone.inning
          ? `Live in the ${ordinal(keystone.inning)}${keystone.inningHalf ? ` (${keystone.inningHalf})` : ""}.`
          : "Live now."
        : keystone.firstPitch
        ? `First pitch at ${formatTimeInAppTz(keystone.firstPitch)}.`
        : "First pitch TBD.";
    cards.push(
      <TodayCard
        key="matchup"
        eyebrow="Matchup to Watch"
        title={`${keystone.away?.abbreviation ?? "AWY"} @ ${keystone.home?.abbreviation ?? "HME"}`}
        sub={keystone.venue ?? ""}
        body={`${stateLine} ${lineupNote}`}
        to="/game/$gamePk"
        params={{ gamePk: String(keystone.gamePk ?? "") }}
        cta="Open Game Hub"
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
      ? "border-[color-mix(in_oklab,var(--riser,#10b981)_45%,transparent)] bg-[color-mix(in_oklab,var(--riser,#10b981)_8%,var(--charcoal))]"
      : "border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_82%,transparent)]";
  return (
    <Link
      to={to}
      params={params}
      className={`group block rounded-md border px-4 py-4 backdrop-blur-sm transition-all hover:border-[color-mix(in_oklab,var(--brass)_55%,var(--border))] ${toneCls}`}
    >
      <div className="mono text-[10px] uppercase tracking-[0.22em] text-[var(--primary)]">
        {eyebrow}
      </div>
      <div className="mt-1.5 text-[18px] font-semibold text-[var(--cream)] md:text-[20px]">
        {title}
      </div>
      {sub && (
        <div className="mono text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
          {sub}
        </div>
      )}
      <p className="mt-2 text-xs text-[var(--parchment)] md:text-sm">{body}</p>
      <div className="mono mt-3 text-[10px] uppercase tracking-widest text-[var(--primary)] group-hover:text-[var(--cream)]">
        {cta} →
      </div>
    </Link>
  );
}

function MoverGrid<T extends { mlbId: number }>({
  risers,
  fallers,
  renderRiser,
  renderFaller,
  emptyRisers,
  emptyFallers,
}: {
  risers: T[];
  fallers: T[];
  renderRiser: (m: T) => React.ReactNode;
  renderFaller: (m: T) => React.ReactNode;
  emptyRisers: string;
  emptyFallers: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <div>
        <div className="mono mb-2 text-[10px] uppercase tracking-widest text-[color-mix(in_oklab,var(--riser,#10b981)_75%,var(--cream))]">
          Risers
        </div>
        {risers.length === 0 ? (
          <EmptyLine>{emptyRisers}</EmptyLine>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {risers.map((r) => (
              <div key={r.mlbId}>{renderRiser(r)}</div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="mono mb-2 text-[10px] uppercase tracking-widest text-[color-mix(in_oklab,var(--faller,#ec4899)_75%,var(--cream))]">
          Fallers
        </div>
        {fallers.length === 0 ? (
          <EmptyLine>{emptyFallers}</EmptyLine>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {fallers.map((f) => (
              <div key={f.mlbId}>{renderFaller(f)}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EngineBetaStatusPanel() {
  // Lazy import to avoid pulling admin-only fn types into non-admin bundle graph
  const { getEngineBetaDataHealth } = require("@/lib/engine-beta/health.functions") as typeof import("@/lib/engine-beta/health.functions");
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
  } else if (autolock && autolock.detail && autolock.detail.includes("missed") && !autolock.detail.startsWith("0 missed") && autolock.detail.match(/(\d+) missed/)?.[1] !== "0") {
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
      ? "border-[color-mix(in_oklab,var(--riser,#10b981)_50%,transparent)]"
      : tone === "warn"
      ? "border-[color-mix(in_oklab,var(--brass)_55%,transparent)]"
      : "border-[color-mix(in_oklab,var(--faller,#ec4899)_55%,transparent)]";

  return (
    <section className="mt-12">
      <SectionHeader title="Engine Beta" />
      <Link
        to="/engine-beta"
        className={`glass-panel block rounded-md border px-4 py-4 transition-colors hover:border-[var(--brass)] ${toneCls}`}
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="mono text-[10px] uppercase tracking-[0.22em] text-[var(--violet-glow)]">
              Admin · Experimental
            </div>
            <div className="mt-1 text-[18px] font-semibold text-[var(--cream)]">{headline}</div>
            {forecast?.latestAt && (
              <div className="mono mt-1 text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
                Latest forecast · {formatTimeInAppTz(forecast.latestAt)}
              </div>
            )}
            {autolock?.detail && (
              <div className="mono mt-0.5 text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
                {autolock.detail}
              </div>
            )}
          </div>
          <div className="mono text-[10px] uppercase tracking-widest text-[var(--primary)]">
            Open Engine Beta →
          </div>
        </div>
      </Link>
    </section>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
