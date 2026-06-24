import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getStandings, type DivisionStandings } from "@/lib/mlb.functions";

const standingsQuery = queryOptions({
  queryKey: ["standings"],
  queryFn: () => getStandings({ data: {} }),
  staleTime: 5 * 60 * 1000,
});

export const Route = createFileRoute("/standings")({
  head: () => ({
    meta: [
      { title: "MLB Standings — Diamond" },
      { name: "description", content: "MLB standings by division with win %, GB, streak, and run differential." },
      { property: "og:title", content: "MLB Standings — Diamond" },
      { property: "og:description", content: "Division standings with run diff and last 10." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(standingsQuery),
  component: StandingsPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load standings: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">No standings.</div>,
});

function StandingsPage() {
  const { data } = useSuspenseQuery(standingsQuery);
  const al = data.divisions.filter((d) => d.divisionName.startsWith("AL"));
  const nl = data.divisions.filter((d) => d.divisionName.startsWith("NL"));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="mb-6">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">{data.season} Season</div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Standings</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <League label="American League" divisions={al} />
        <League label="National League" divisions={nl} />
      </div>
    </div>
  );
}

function League({ label, divisions }: { label: string; divisions: DivisionStandings[] }) {
  return (
    <div className="space-y-6">
      <h2 className="font-display text-lg font-semibold uppercase tracking-wider text-muted-foreground">{label}</h2>
      {divisions.map((div) => (
        <div key={div.divisionId} className="overflow-hidden rounded-lg border border-border/70 bg-card">
          <div className="border-b border-border/60 bg-secondary/40 px-4 py-2">
            <span className="font-display text-sm font-semibold uppercase tracking-widest">
              {div.divisionName}
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 text-left">Team</th>
                <th className="px-2 py-2 text-right">W</th>
                <th className="px-2 py-2 text-right">L</th>
                <th className="px-2 py-2 text-right">PCT</th>
                <th className="px-2 py-2 text-right">GB</th>
                <th className="hidden px-2 py-2 text-right sm:table-cell">L10</th>
                <th className="hidden px-2 py-2 text-right sm:table-cell">STRK</th>
                <th className="px-2 py-2 pr-3 text-right">DIFF</th>
              </tr>
            </thead>
            <tbody>
              {div.teams.map((t, i) => (
                <tr
                  key={t.teamId}
                  className={`border-t border-border/40 ${i === 0 ? "bg-primary/5" : ""}`}
                >
                  <td className="px-3 py-2">
                    <Link
                      to="/teams/$teamId"
                      params={{ teamId: String(t.teamId) }}
                      className="flex items-center gap-2 hover:text-primary"
                    >
                      <span className="mono inline-flex h-6 w-9 items-center justify-center rounded bg-secondary text-[11px] font-bold">
                        {t.abbreviation}
                      </span>
                      <span className="truncate">{t.name}</span>
                    </Link>
                  </td>
                  <td className="mono px-2 py-2 text-right">{t.wins}</td>
                  <td className="mono px-2 py-2 text-right">{t.losses}</td>
                  <td className="mono px-2 py-2 text-right">{t.pct}</td>
                  <td className="mono px-2 py-2 text-right">{t.gb}</td>
                  <td className="mono hidden px-2 py-2 text-right sm:table-cell">{t.last10}</td>
                  <td className="mono hidden px-2 py-2 text-right sm:table-cell">{t.streak}</td>
                  <td className={`mono px-2 py-2 pr-3 text-right ${t.runDiff >= 0 ? "text-edge" : "text-destructive"}`}>
                    {t.runDiff > 0 ? "+" : ""}{t.runDiff}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
