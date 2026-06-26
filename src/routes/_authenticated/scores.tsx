import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { getSchedule } from "@/lib/mlb.functions";
import { ScoreCard } from "@/components/score-card";
import { shiftIsoDate } from "@/lib/timezone";


const searchSchema = z.object({
  date: z.string().optional(),
});

function scheduleQueryFor(date: string | undefined) {
  return queryOptions({
    queryKey: ["schedule", date ?? "today"],
    queryFn: () => getSchedule({ data: date ? { date } : {} }),
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    throwOnError: (_err, query) => query.state.data === undefined,
  });
}

export const Route = createFileRoute("/_authenticated/scores")({
  head: () => ({
    meta: [
      { title: "MLB Scoreboard — Diamond" },
      { name: "description", content: "Today's full MLB scoreboard with live game status." },
      { property: "og:title", content: "MLB Scoreboard — Diamond" },
      { property: "og:description", content: "Live MLB scores, status, and probable pitchers." },
    ],
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ date: search.date }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(scheduleQueryFor(deps.date)),
  component: ScoresPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load scores: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">No games.</div>,
});

function shiftDate(iso: string, days: number): string {
  return shiftIsoDate(iso, days);
}


function ScoresPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(scheduleQueryFor(search.date));

  const live = data.games.filter((g) => g.isLive);
  const upcoming = data.games.filter((g) => !g.isLive && !g.isFinal);
  const finals = data.games.filter((g) => g.isFinal);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">Scoreboard</div>
          <h1 className="font-display text-3xl font-bold tracking-tight">{data.date}</h1>
        </div>
        <div className="flex items-center gap-2">
          <DateButton onClick={() => navigate({ search: { date: shiftDate(data.date, -1) } })}>
            ← Prev
          </DateButton>
          <DateButton onClick={() => navigate({ search: {} })}>Today</DateButton>
          <DateButton onClick={() => navigate({ search: { date: shiftDate(data.date, 1) } })}>
            Next →
          </DateButton>
        </div>
      </div>

      <Section title="Live" count={live.length} accent="live">
        {live.map((g) => <ScoreCard key={g.gamePk} game={g} />)}
      </Section>
      <Section title="Upcoming" count={upcoming.length}>
        {upcoming.map((g) => <ScoreCard key={g.gamePk} game={g} />)}
      </Section>
      <Section title="Final" count={finals.length}>
        {finals.map((g) => <ScoreCard key={g.gamePk} game={g} />)}
      </Section>

      {data.games.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 bg-card/40 p-10 text-center text-sm text-muted-foreground">
          No MLB games on {data.date}.
        </div>
      ) : null}
    </div>
  );
}

function DateButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="mono rounded-md border border-border/70 bg-card px-3 py-1.5 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Section({
  title, count, accent, children,
}: { title: string; count: number; accent?: "live"; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold uppercase tracking-wider">
        {accent === "live" ? <span className="h-2 w-2 animate-pulse rounded-full bg-live" /> : null}
        <span className={accent === "live" ? "text-live" : "text-muted-foreground"}>{title}</span>
        <span className="mono text-xs text-muted-foreground">({count})</span>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}
