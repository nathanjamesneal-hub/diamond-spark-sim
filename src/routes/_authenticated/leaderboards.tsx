import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getLeaderboards } from "@/lib/mlb.functions";

const leadersQuery = queryOptions({
  queryKey: ["leaderboards"],
  queryFn: () => getLeaderboards({ data: {} }),
  staleTime: 10 * 60 * 1000,
});

export const Route = createFileRoute("/_authenticated/leaderboards")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "MLB Leaderboards — Diamond" },
      { name: "description", content: "MLB leaders in HR, AVG, RBI, OPS, SB, ERA, K, and Wins." },
      { property: "og:title", content: "MLB Leaderboards — Diamond" },
      { property: "og:description", content: "League leaders, batting and pitching." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(leadersQuery),
  component: LeadersPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load leaders: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">No leaders.</div>,
});

function LeadersPage() {
  const { data } = useSuspenseQuery(leadersQuery);
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="mb-6">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">{data.season}</div>
        <h1 className="font-display text-3xl font-bold tracking-tight">League Leaders</h1>
      </div>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {data.categories.map((cat) => (
          <div key={cat.key} className="overflow-hidden rounded-lg border border-border/70 bg-card">
            <div className="border-b border-border/60 bg-secondary/40 px-4 py-2">
              <span className="font-display text-sm font-semibold uppercase tracking-widest">
                {cat.label}
              </span>
            </div>
            {cat.rows.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">No data.</div>
            ) : (
              <ol>
                {cat.rows.map((r) => (
                  <li
                    key={`${cat.key}-${r.playerId}-${r.rank}`}
                    className="flex items-center justify-between gap-3 border-t border-border/40 px-4 py-2 first:border-t-0"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="mono w-5 text-right text-xs text-muted-foreground">
                        {r.rank}
                      </span>
                      <Link
                        to="/players/$playerId"
                        params={{ playerId: String(r.playerId) }}
                        className="min-w-0 truncate text-sm hover:text-primary"
                      >
                        {r.playerName}
                      </Link>
                      <span className="mono hidden truncate text-[11px] text-muted-foreground sm:inline">
                        {r.teamName}
                      </span>
                    </div>
                    <span className="mono text-sm font-bold tabular-nums text-primary">
                      {r.value}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
