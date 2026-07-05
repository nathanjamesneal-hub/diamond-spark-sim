import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getMlbMovers } from "@/lib/movers.functions";
import { PitcherCard } from "@/components/movers/mover-cards";

const q = queryOptions({
  queryKey: ["mlb-movers"],
  queryFn: () => getMlbMovers({ data: {} }),
  staleTime: 5 * 60_000,
});

export const Route = createFileRoute("/_authenticated/pitchers")({
  head: () => ({
    meta: [
      { title: "Pitchers — Diamond Live" },
      { name: "description", content: "MLB pitcher risers and fallers from verified game data." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(q),
  errorComponent: ({ error, reset }) => (
    <div className="p-8"><p>{String((error as any)?.message ?? error)}</p><button className="mono mt-3 rounded border border-border px-3 py-1 text-xs" onClick={() => reset()}>Retry</button></div>
  ),
  notFoundComponent: () => <div className="p-8">Not found.</div>,
  component: PitchersPage,
});

function PitchersPage() {
  const { data } = useSuspenseQuery(q);
  const [tab, setTab] = useState<"risers" | "fallers">("risers");
  const list = tab === "risers" ? data.pitchers.risers : data.pitchers.fallers;
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="eyebrow text-[var(--primary)]">Diamond Live</div>
      <h1 className="mt-1 text-[36px] leading-tight text-[var(--cream)] md:text-[52px]">
        Pitchers
      </h1>
      <p className="mt-2 text-sm text-[var(--warm-muted)]">
        Last {data.window.pitcher.recentDays} days ({data.recentStartDate} → {data.recentEndDate}) vs season.
        Min {data.window.pitcher.seasonIp} season IP and either {data.window.pitcher.recentIpMin}+ recent IP,
        or {data.window.pitcher.recentAppsWithIp}+ apps &amp; {data.window.pitcher.recentIpWithApps}+ IP.
      </p>
      <div className="mt-5 flex gap-1 border-b border-[var(--border)]">
        {(["risers", "fallers"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`mono px-3 py-2 text-xs font-bold uppercase tracking-[0.2em] ${
              tab === t
                ? "border-b-2 border-[var(--primary)] text-[var(--cream)]"
                : "text-[var(--warm-muted)] hover:text-[var(--cream)]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {list.map((m) => <PitcherCard key={m.mlbId} m={m} />)}
        {list.length === 0 ? (
          <div className="col-span-full rounded-sm border border-dashed border-[var(--border)] px-4 py-8 text-center text-xs text-[var(--warm-muted)]">
            No pitchers currently qualify.
          </div>
        ) : null}
      </div>
    </div>
  );
}

