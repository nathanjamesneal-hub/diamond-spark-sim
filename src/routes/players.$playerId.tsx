import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getPlayer, type PlayerStatLine } from "@/lib/mlb.functions";
import { SimMethodologyTooltip } from "@/components/diamond/sim-methodology-tooltip";
import { PrimaryMetricsRow } from "@/components/diamond/primary-metrics-row";
import { SimDetails } from "@/components/diamond/sim-details";
import { PredictionDrivers } from "@/components/diamond/prediction-drivers";
import { WhyTheModelLikesThis } from "@/components/diamond/why-model-likes-this";


function playerQuery(playerId: number) {
  return queryOptions({
    queryKey: ["player", playerId],
    queryFn: () => getPlayer({ data: { playerId } }),
    staleTime: 10 * 60 * 1000,
  });
}

export const Route = createFileRoute("/players/$playerId")({
  head: () => ({
    meta: [
      { title: "Player — Diamond" },
      { name: "description", content: "MLB player profile: season, career, and year-by-year stats." },
      { property: "og:title", content: "Player — Diamond" },
      { property: "og:description", content: "Season, career, and projections." },
    ],
  }),
  loader: ({ context, params }) => {
    const id = Number(params.playerId);
    if (!Number.isFinite(id)) throw notFound();
    return context.queryClient.ensureQueryData(playerQuery(id));
  },
  component: PlayerPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load player: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">Player not found.</div>,
});

function PlayerPage() {
  const { playerId } = Route.useParams();
  const { data } = useSuspenseQuery(playerQuery(Number(playerId)));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary font-display text-2xl font-bold">
          {data.primaryNumber}
        </div>
        <div className="min-w-0">
          <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">
            {data.position} · {data.primaryPositionType}
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight">{data.fullName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {data.currentTeam ? (
              <Link
                to="/teams/$teamId"
                params={{ teamId: String(data.currentTeam.id) }}
                className="hover:text-primary"
              >
                {data.currentTeam.name}
              </Link>
            ) : null}
            <span>·</span>
            <span>Bats {data.bats} / Throws {data.throws}</span>
            {data.height ? <><span>·</span><span>{data.height}{data.weight ? `, ${data.weight} lbs` : ""}</span></> : null}
            {data.birthCity ? <><span>·</span><span>{data.birthCity}{data.birthCountry ? `, ${data.birthCountry}` : ""}</span></> : null}
          </div>
        </div>
      </div>

      <div className="mb-8 grid gap-3 md:grid-cols-2">
        <StatBlock title="Current season" line={data.season} group={data.group} highlight />
        <StatBlock title="Career" line={data.career} group={data.group} />
      </div>

      <ProjectionPlaceholder name={data.fullName} group={data.group} />

      <h2 className="mb-3 mt-10 font-display text-lg font-semibold uppercase tracking-wider text-muted-foreground">
        Year by year
      </h2>
      <div className="overflow-x-auto rounded-lg border border-border/70 bg-card">
        <StatTable history={data.history} group={data.group} />
      </div>
    </div>
  );
}

function StatBlock({
  title, line, group, highlight,
}: { title: string; line: PlayerStatLine | null; group: "hitting" | "pitching"; highlight?: boolean }) {
  if (!line) {
    return (
      <div className="rounded-lg border border-border/70 bg-card p-4">
        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{title}</div>
        <div className="mt-3 text-sm text-muted-foreground">No data.</div>
      </div>
    );
  }
  const stats: Array<[string, string | number | undefined]> = group === "hitting"
    ? [["AVG", line.avg], ["OBP", line.obp], ["SLG", line.slg], ["OPS", line.ops],
       ["HR", line.hr], ["RBI", line.rbi], ["SB", line.sb], ["R", line.runs]]
    : [["ERA", line.era], ["WHIP", line.whip], ["W-L", `${line.w ?? 0}-${line.l ?? 0}`],
       ["SV", line.sv], ["SO", line.so], ["IP", line.ip]];

  return (
    <div className={`rounded-lg border bg-card p-4 ${highlight ? "border-primary/40" : "border-border/70"}`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {title} {line.season ? `· ${line.season}` : ""}
        </div>
        {line.team ? <div className="mono text-[11px] text-muted-foreground">{line.team}</div> : null}
      </div>
      <div className="grid grid-cols-4 gap-3">
        {stats.map(([k, v]) => (
          <div key={k}>
            <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{k}</div>
            <div className="mono mt-1 text-lg font-bold tabular-nums">{v ?? "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectionPlaceholder({ name, group }: { name: string; group: "hitting" | "pitching" }) {
  // Per-player Monte Carlo distributions are produced on the matchup page.
  // Here we expose the simulation engine's structure transparently — without
  // synthesizing any numbers — so the player profile reads as a model output.
  return (
    <div className="space-y-3 rounded-lg border border-edge/40 bg-edge/[0.03] p-4">
      <div className="flex items-center justify-between">
        <div className="mono flex items-center gap-1 text-[10px] uppercase tracking-widest text-edge">
          Next-game simulation
          <SimMethodologyTooltip />
        </div>
        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Diamond engine · 2,000 sims
        </div>
      </div>

      <PrimaryMetricsRow
        diamondScore={null}
        meanProjection={null}
        meanLabel={group === "hitting" ? "Mean Hits" : "Mean Outs"}
        probability={null}
        probabilityLabel={group === "hitting" ? "Hit Probability" : "QS Probability"}
        confidence={null}
        edge={null}
      />

      <SimDetails
        mean={null}
        median={null}
        stdev={null}
        percentile90={null}
        fractionDigits={group === "hitting" ? 2 : 1}
      />

      <PredictionDrivers
        battingOrder={null}
        opposingPitcher={null}
        parkFactor={null}
        platoonAdvantage={null}
        bullpenAdjustment={null}
        weather={null}
        recentForm={null}
        lineupStatus={null}
      />

      <p className="text-xs text-muted-foreground">
        Open today's matchup page to see {name}'s live per-batter Monte Carlo distribution.
      </p>
    </div>
  );
}


function StatTable({ history, group }: { history: PlayerStatLine[]; group: "hitting" | "pitching" }) {
  if (history.length === 0) {
    return <div className="p-6 text-center text-sm text-muted-foreground">No year-by-year data.</div>;
  }
  const headers = group === "hitting"
    ? ["Year", "Team", "AB", "H", "HR", "RBI", "SB", "AVG", "OBP", "SLG", "OPS"]
    : ["Year", "Team", "W", "L", "SV", "IP", "SO", "ERA", "WHIP"];
  const cellFor = group === "hitting"
    ? (l: PlayerStatLine) => [l.ab, l.hits, l.hr, l.rbi, l.sb, l.avg, l.obp, l.slg, l.ops]
    : (l: PlayerStatLine) => [l.w, l.l, l.sv, l.ip, l.so, l.era, l.whip];
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {headers.map((h) => (
            <th key={h} className={`px-3 py-2 ${h === "Year" || h === "Team" ? "text-left" : "text-right"}`}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {history.map((l, i) => (
          <tr key={`${l.season}-${l.team}-${i}`} className="border-t border-border/40">
            <td className="mono px-3 py-2 text-left">{l.season}</td>
            <td className="px-3 py-2 text-left text-muted-foreground">{l.team || "—"}</td>
            {cellFor(l).map((v, j) => (
              <td key={j} className="mono px-3 py-2 text-right tabular-nums">{v ?? "—"}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
