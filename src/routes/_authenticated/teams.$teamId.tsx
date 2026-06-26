import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getTeam, type RosterPlayer } from "@/lib/mlb.functions";

function teamQuery(teamId: number) {
  return queryOptions({
    queryKey: ["team", teamId],
    queryFn: () => getTeam({ data: { teamId } }),
    staleTime: 10 * 60 * 1000,
  });
}

export const Route = createFileRoute("/_authenticated/teams/$teamId")({
  head: () => ({
    meta: [
      { title: "Team — Diamond" },
      { name: "description", content: "MLB team page: roster, venue, league, and stats." },
      { property: "og:title", content: "Team — Diamond" },
      { property: "og:description", content: "Roster and team info." },
    ],
  }),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(teamQuery(Number(params.teamId))),
  component: TeamPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load team: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">Team not found.</div>,
});

function TeamPage() {
  const { teamId } = Route.useParams();
  const { data } = useSuspenseQuery(teamQuery(Number(teamId)));

  const groups: Array<RosterPlayer["positionGroup"]> = [
    "Pitcher", "Catcher", "Infielder", "Outfielder", "Other",
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="mb-6 flex items-start gap-4">
        <div className="flex h-16 w-20 items-center justify-center rounded-lg bg-secondary font-display text-2xl font-bold">
          {data.abbreviation}
        </div>
        <div>
          <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">
            {data.league} · {data.division}
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight">{data.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.venue}{data.firstYearOfPlay ? ` · est. ${data.firstYearOfPlay}` : ""}
          </p>
        </div>
      </div>

      <h2 className="mb-3 font-display text-lg font-semibold uppercase tracking-wider text-muted-foreground">
        Active Roster
      </h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => {
          const players = data.roster.filter((p) => p.positionGroup === g);
          if (players.length === 0) return null;
          return (
            <div key={g} className="overflow-hidden rounded-lg border border-border/70 bg-card">
              <div className="border-b border-border/60 bg-secondary/40 px-4 py-2">
                <span className="font-display text-sm font-semibold uppercase tracking-widest">
                  {g}s <span className="mono text-xs text-muted-foreground">({players.length})</span>
                </span>
              </div>
              <ul>
                {players.map((p) => (
                  <li key={p.id} className="border-t border-border/40 first:border-t-0">
                    <Link
                      to="/players/$playerId"
                      params={{ playerId: String(p.id) }}
                      className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-secondary/40 hover:text-primary"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="mono w-8 text-right text-xs text-muted-foreground">
                          #{p.jerseyNumber}
                        </span>
                        <span className="min-w-0 truncate text-sm">{p.fullName}</span>
                      </div>
                      <span className="mono rounded bg-secondary px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                        {p.position}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}


