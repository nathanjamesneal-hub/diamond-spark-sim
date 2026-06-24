import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getTodaysSlate, type SlateRow } from "@/lib/projections.functions";

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

      {data.rows.length === 0 ? <EmptySlate /> : <SlateTable rows={data.rows} />}
    </div>
  );
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

function EmptySlate() {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-card/30 p-10 text-center">
      <div className="mono text-xs uppercase tracking-widest text-muted-foreground">Slate empty</div>
      <p className="mt-2 text-sm text-muted-foreground">
        No projections for today yet. See{" "}
        <Link to="/lineup-status" className="text-primary hover:underline">/lineup-status</Link>{" "}
        to see what's missing and push games through the pipeline.
      </p>
    </div>
  );
}
