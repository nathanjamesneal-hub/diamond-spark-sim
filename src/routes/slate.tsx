import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getTodaysSlate, type SlateRow, type SlateGame, type SlateDiagnostics } from "@/lib/projections.functions";

const slateQuery = queryOptions({
  queryKey: ["slate", "today"],
  queryFn: () => getTodaysSlate({ data: {} }),
  staleTime: 60 * 1000,
});

export const Route = createFileRoute("/slate")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Today's Slate · Diamond" },
      { name: "description", content: "Diamond projections for every hitter on today's MLB slate." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(slateQuery),
  component: SlatePage,
  errorComponent: ({ error }) => <div className="p-8 text-sm text-muted-foreground">Couldn't load slate: {error.message}</div>,
  notFoundComponent: () => <div className="p-8">Not found.</div>,
});

function SlatePage() {
  const { data } = useSuspenseQuery(slateQuery);
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-6">
      <div className="mb-6">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">
          {data.date} · model v{data.modelVersion ?? "—"}
        </div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Today's slate</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every projection is versioned and stored. Click any player for full history.
        </p>
      </div>

      <DiagnosticsBanner diagnostics={data.diagnostics} games={data.games} />

      {data.games.length > 0 && <GamesGrid games={data.games} />}

      <div className="mt-8">
        {data.rows.length === 0 ? <EmptySlate hasGames={data.games.length > 0} /> : <SlateTable rows={data.rows} />}
      </div>
    </div>
  );
}

function DiagnosticsBanner({ diagnostics, games }: { diagnostics: SlateDiagnostics; games: SlateGame[] }) {
  const truelyEmpty = diagnostics.api_game_count === 0;
  return (
    <div className="mb-6 rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="mono uppercase tracking-widest text-muted-foreground">Pipeline</span>
        <Pill label={`MLB API: ${diagnostics.api_game_count}`} tone={truelyEmpty ? "warn" : "ok"} />
        <Pill label={`Imported: ${diagnostics.db_game_count}`} tone={diagnostics.db_game_count ? "ok" : "warn"} />
        <Pill label={`Lineups: ${diagnostics.lineup_count}`} tone={diagnostics.lineup_count ? "ok" : "muted"} />
        <Pill label={`Projections: ${diagnostics.projection_count}`} tone={diagnostics.projection_count ? "ok" : "muted"} />
        <Pill label={`Showing: ${games.length}`} tone="muted" />
      </div>
      {diagnostics.note && (
        <p className="mt-2 text-sm text-muted-foreground">{diagnostics.note}</p>
      )}
      {diagnostics.filtered_out.length > 0 && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{diagnostics.filtered_out.length} games flagged</summary>
          <ul className="mt-1 list-disc pl-5">
            {diagnostics.filtered_out.map((f) => (
              <li key={f.gamePk}>gamePk {f.gamePk}: {f.reason}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Pill({ label, tone }: { label: string; tone: "ok" | "warn" | "muted" }) {
  const cls =
    tone === "ok" ? "bg-edge/15 text-edge"
    : tone === "warn" ? "bg-primary/15 text-primary"
    : "bg-secondary text-muted-foreground";
  return <span className={`mono rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${cls}`}>{label}</span>;
}

function GamesGrid({ games }: { games: SlateGame[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {games.map((g) => (
        <div key={g.gamePk ?? Math.random()} className="rounded-lg border border-border/60 bg-card/30 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="mono font-bold">{g.away.abbrev} @ {g.home.abbrev}</span>
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{g.status}</span>
          </div>
          <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            <div>{g.away.abbrev} SP: <span className="text-foreground">{g.away.probablePitcher ?? "TBD"}</span></div>
            <div>{g.home.abbrev} SP: <span className="text-foreground">{g.home.probablePitcher ?? "TBD"}</span></div>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[10px]">
            <LineupBadge status={g.lineup_status} hitters={g.hitters_set} />
            {g.has_projections && <Pill label="Projected" tone="ok" />}
            {!g.game_id && <Pill label="Not imported" tone="warn" />}
          </div>
        </div>
      ))}
    </div>
  );
}

function LineupBadge({ status, hitters }: { status: SlateGame["lineup_status"]; hitters: number }) {
  const map = {
    verified: { label: `Lineup ${hitters}/9`, tone: "ok" as const },
    waiting: { label: `Lineup ${hitters}/9`, tone: "warn" as const },
    locked: { label: `Locked ${hitters}/9`, tone: "ok" as const },
    missing: { label: "No lineup", tone: "muted" as const },
  };
  const m = map[status];
  return <Pill label={m.label} tone={m.tone} />;
}

function SlateTable({ rows }: { rows: SlateRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="mono w-full text-xs">
        <thead className="bg-secondary/40 text-muted-foreground">
          <tr>
            {["Player", "Team", "Opp", "Diamond", "Hit%", "TB%", "HR%", "RBI%", "Run%", "SB%", "Conf", "Status"].map((h) => (
              <th key={h} className="px-3 py-2 text-left uppercase tracking-widest">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.player_id + r.game_id} className="border-t border-border/40 hover:bg-secondary/20">
              <td className="px-3 py-2">
                <Link to="/players/$playerId" params={{ playerId: r.player_id }} className="text-foreground hover:text-primary">
                  {r.player_name}
                </Link>
              </td>
              <td className="px-3 py-2">{r.team_abbrev}</td>
              <td className="px-3 py-2 text-muted-foreground">{r.opp_abbrev}</td>
              <td className="px-3 py-2 font-bold text-foreground">{r.diamond_score ?? "—"}</td>
              <td className="px-3 py-2">{fmtPct(r.hit_probability)}</td>
              <td className="px-3 py-2">{fmtPct(r.total_base_probability)}</td>
              <td className="px-3 py-2">{fmtPct(r.hr_probability)}</td>
              <td className="px-3 py-2">{fmtPct(r.rbi_probability)}</td>
              <td className="px-3 py-2">{fmtPct(r.run_probability)}</td>
              <td className="px-3 py-2">{fmtPct(r.sb_probability)}</td>
              <td className="px-3 py-2">{r.confidence ?? "—"}</td>
              <td className="px-3 py-2"><StatusPill status={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmtPct(p: number | null) {
  if (p == null) return <span className="text-muted-foreground/60">—</span>;
  return <span>{Math.round(p * 100)}%</span>;
}

function StatusPill({ status }: { status: SlateRow["status"] }) {
  const map = {
    verified: { label: "Verified", cls: "bg-edge/15 text-edge" },
    waiting: { label: "Waiting for lineup", cls: "bg-secondary text-muted-foreground" },
    locked: { label: "Locked", cls: "bg-primary/15 text-primary" },
  } as const;
  const m = map[status];
  return <span className={`mono inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${m.cls}`}>{m.label}</span>;
}

function EmptySlate({ hasGames }: { hasGames: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-card/30 p-10 text-center">
      <div className="mono text-xs uppercase tracking-widest text-muted-foreground">
        {hasGames ? "Awaiting projections" : "Slate empty"}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasGames
          ? "Games are on the board — lineups and projections will populate as MLB publishes them."
          : "No MLB games are on the schedule for today."}{" "}
        See{" "}
        <Link to="/lineup-status" className="text-primary hover:underline">/lineup-status</Link>{" "}
        to push games through the pipeline.
      </p>
    </div>
  );
}

