import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getMlbMovers } from "@/lib/movers.functions";
import { HitterCard } from "@/components/movers/mover-cards";

const q = queryOptions({
  queryKey: ["mlb-movers"],
  queryFn: () => getMlbMovers({ data: {} }),
  staleTime: 5 * 60_000,
});

export const Route = createFileRoute("/_authenticated/hitters")({
  head: () => ({
    meta: [
      { title: "Hitters — Diamond Live" },
      { name: "description", content: "MLB hitter risers and fallers from verified game data." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(q),
  errorComponent: ({ error, reset }) => (
    <div className="p-8"><p>{String((error as any)?.message ?? error)}</p><button className="mono mt-3 rounded border border-border px-3 py-1 text-xs" onClick={() => reset()}>Retry</button></div>
  ),
  notFoundComponent: () => <div className="p-8">Not found.</div>,
  component: HittersPage,
});

function HittersPage() {
  const { data } = useSuspenseQuery(q);
  const [tab, setTab] = useState<"risers" | "fallers">("risers");
  const list = tab === "risers" ? data.hitters.risers : data.hitters.fallers;
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="mono text-[10px] uppercase tracking-[0.3em] text-primary/80">Diamond Live</div>
      <h1 className="mt-1 text-2xl font-semibold text-foreground md:text-3xl">Hitters</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Last {data.window.hitter.recentDays} days ({data.recentStartDate} → {data.recentEndDate}) vs season.
        Min {data.window.hitter.recentPa} recent PA, {data.window.hitter.seasonPa} season PA.
      </p>
      <div className="mt-5 flex gap-1 border-b border-border/60">
        {(["risers", "fallers"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`mono px-3 py-2 text-xs uppercase tracking-widest ${tab === t ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {list.map((m) => <HitterCard key={m.mlbId} m={m} />)}
        {list.length === 0 ? (
          <div className="col-span-full rounded border border-dashed border-border/60 bg-black/20 px-4 py-8 text-center text-xs text-muted-foreground">
            No hitters currently qualify.
          </div>
        ) : null}
      </div>
    </div>
  );
}
