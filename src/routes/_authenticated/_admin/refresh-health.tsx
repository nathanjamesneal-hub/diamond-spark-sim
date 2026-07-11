/**
 * Projection Refresh Health — admin observability for the staged-projection
 * scheduler. Read-only, plus a manual "Run refresh audit" button that hits
 * the exact server-side planner path pg_cron calls.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getRefreshHealth, runProjectionRefreshNow } from "@/lib/projection-refresh/health.functions";
import { ProjectionStageBadge, type ProjectionStage } from "@/components/diamond/projection-stage-badge";
import { Button } from "@/components/ui/button";

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function minutesTo(iso: string | null): string {
  if (!iso) return "—";
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (m > 60) return `${Math.round(m / 60)}h`;
  return `${m}m`;
}

function RefreshHealthPage() {
  const q = useServerFn(getRefreshHealth);
  const run = useServerFn(runProjectionRefreshNow);
  const qc = useQueryClient();
  const health = useQuery({
    queryKey: ["refresh-health"],
    queryFn: () => q({ data: {} }),
    refetchInterval: 30_000,
  });
  const mut = useMutation({
    mutationFn: () => run({ data: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["refresh-health"] }),
  });

  if (health.isLoading) return <div className="p-6 text-neutral-400 font-mono text-sm">Loading refresh health…</div>;
  if (health.error || !health.data)
    return <div className="p-6 text-red-400 font-mono text-sm">Failed to load refresh health.</div>;
  const h = health.data;
  const c = h.counters;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-mono">
      <div className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-lg tracking-widest uppercase text-neutral-200">
              Projection Refresh Health
            </h1>
            <p className="text-xs text-neutral-500 mt-1">
              Slate {h.slateDate} · Scheduler last run {fmtTime(h.scheduler.lastRunAt)} ·{" "}
              {h.scheduler.lastStatus ?? "—"} · {h.scheduler.lastDurationMs ?? 0}ms
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "Running…" : "Run projection refresh audit"}
          </Button>
        </header>

        <section className="grid grid-cols-2 md:grid-cols-6 gap-2">
          {[
            ["Games tracked", c.gamesTracked],
            ["Early", c.early],
            ["Updated", c.updated],
            ["Confirmed", c.lineup_confirmed],
            ["Final pregame", c.final_pregame],
            ["Awaiting SP", c.awaiting_probable_pitchers],
            ["Awaiting lineup", c.awaiting_confirmed_lineup],
            ["Inputs unchanged", c.inputs_unchanged],
            ["Started", c.game_started],
            ["Postponed", c.postponed],
            ["Stale jobs", c.stale_jobs],
            ["Failed jobs", c.failed_jobs],
          ].map(([label, val]) => (
            <div
              key={String(label)}
              className="border border-neutral-800 rounded bg-neutral-900/60 px-3 py-2"
            >
              <div className="text-[10px] uppercase tracking-widest text-neutral-500">{label}</div>
              <div className="text-lg text-neutral-100">{String(val)}</div>
            </div>
          ))}
        </section>

        <section className="border border-neutral-800 rounded bg-neutral-900/40 p-3">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2">
            Market refresh (no engine rerun)
          </div>
          <div className="text-sm text-neutral-300">
            Last {fmtTime(h.marketRefresh.lastRunAt)} · considered{" "}
            {h.marketRefresh.lastConsideredGames ?? 0} games · updated{" "}
            {h.marketRefresh.lastUpdatedRows ?? 0} rows
            {h.marketRefresh.lastSkippedReason ? ` · ${h.marketRefresh.lastSkippedReason}` : ""}
          </div>
        </section>

        <section className="border border-neutral-800 rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-neutral-900 text-neutral-400 uppercase tracking-widest">
              <tr>
                <th className="text-left px-2 py-2">Game</th>
                <th className="text-left px-2 py-2">First pitch</th>
                <th className="text-left px-2 py-2">Stage</th>
                <th className="text-left px-2 py-2">Lifecycle</th>
                <th className="text-left px-2 py-2">SP</th>
                <th className="text-left px-2 py-2">Lineup</th>
                <th className="text-left px-2 py-2">Hash</th>
                <th className="text-left px-2 py-2">Last model</th>
                <th className="text-left px-2 py-2">Last market</th>
                <th className="text-left px-2 py-2">Waiting / next action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {h.perGame.map((g) => (
                <tr key={g.gameId} className="hover:bg-neutral-900/50">
                  <td className="px-2 py-2 text-neutral-300">{g.gamePk ?? g.gameId.slice(0, 8)}</td>
                  <td className="px-2 py-2 text-neutral-400">
                    {fmtTime(g.firstPitchAt)}{" "}
                    <span className="text-neutral-600">({minutesTo(g.firstPitchAt)})</span>
                  </td>
                  <td className="px-2 py-2">
                    <ProjectionStageBadge stage={g.projectionStage as ProjectionStage | null} short />
                  </td>
                  <td className="px-2 py-2 text-neutral-300">{g.lifecycleStatus}</td>
                  <td className="px-2 py-2 text-neutral-400">{g.pitcherStatus ?? "—"}</td>
                  <td className="px-2 py-2 text-neutral-400">{g.lineupStatus ?? "—"}</td>
                  <td className="px-2 py-2 text-neutral-500">
                    {g.inputsHash ? g.inputsHash.slice(0, 8) : "—"}
                  </td>
                  <td className="px-2 py-2 text-neutral-400">{fmtTime(g.lastModelUpdateAt)}</td>
                  <td className="px-2 py-2 text-neutral-400">{fmtTime(g.lastMarketUpdateAt)}</td>
                  <td className="px-2 py-2 text-neutral-400">
                    {g.waitingReason ? <span className="text-amber-400">{g.waitingReason}</span> : null}
                    {g.waitingReason && g.nextAction ? " · " : null}
                    {g.nextAction}
                    {g.changeReason ? (
                      <div className="text-[10px] text-neutral-500 mt-0.5">
                        change: {g.changeReason}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {mut.data ? (
          <pre className="text-[10px] p-3 bg-neutral-900/60 border border-neutral-800 rounded overflow-x-auto">
            {JSON.stringify(mut.data, null, 2).slice(0, 4000)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/_admin/refresh-health")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Projection Refresh Health · Diamond Admin" },
      {
        name: "description",
        content:
          "Diamond admin observability for staged projections, inputs-hash reruns, and market-only refresh cycles.",
      },
    ],
  }),
  component: RefreshHealthPage,
});
