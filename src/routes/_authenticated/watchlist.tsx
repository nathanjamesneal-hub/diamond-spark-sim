import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getMlbMovers } from "@/lib/movers.functions";
import { HitterCard, PitcherCard } from "@/components/movers/mover-cards";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const getFavoritePlayerIds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("favorites")
      .select("ref_id, kind")
      .eq("kind", "player");
    if (error) throw new Error(error.message);
    return { ids: (data ?? []).map((r: any) => r.ref_id as number) };
  });

const moversQ = queryOptions({
  queryKey: ["mlb-movers"],
  queryFn: () => getMlbMovers({ data: {} }),
  staleTime: 5 * 60_000,
});

const favQ = queryOptions({
  queryKey: ["favorite-players"],
  queryFn: () => getFavoritePlayerIds(),
  staleTime: 60_000,
});

export const Route = createFileRoute("/_authenticated/watchlist")({
  head: () => ({ meta: [{ title: "Watchlist — Diamond Live" }] }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(moversQ),
      context.queryClient.ensureQueryData(favQ),
    ]);
  },
  errorComponent: ({ error, reset }) => (
    <div className="p-8"><p>{String((error as any)?.message ?? error)}</p><button className="mono mt-3 rounded border border-border px-3 py-1 text-xs" onClick={() => reset()}>Retry</button></div>
  ),
  notFoundComponent: () => <div className="p-8">Not found.</div>,
  component: WatchlistPage,
});

function WatchlistPage() {
  const { data: movers } = useSuspenseQuery(moversQ);
  const { data: fav } = useSuspenseQuery(favQ);
  const idSet = new Set(fav.ids);

  const hitters = [...movers.hitters.risers, ...movers.hitters.fallers].filter((m) => idSet.has(m.mlbId));
  const pitchers = [...movers.pitchers.risers, ...movers.pitchers.fallers].filter((m) => idSet.has(m.mlbId));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="mono text-[10px] uppercase tracking-[0.3em] text-primary/80">Diamond Live</div>
      <h1 className="mt-1 text-2xl font-semibold text-foreground md:text-3xl">Watchlist</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Movers among {fav.ids.length} favorited player{fav.ids.length === 1 ? "" : "s"}.
        Add players from their profile via the star icon.
      </p>

      {fav.ids.length === 0 ? (
        <div className="mt-6 rounded border border-dashed border-border/60 bg-black/20 px-4 py-10 text-center text-sm text-muted-foreground">
          No favorites yet. Star players from{" "}
          <Link to="/hitters" className="text-primary hover:underline">Hitters</Link> or{" "}
          <Link to="/pitchers" className="text-primary hover:underline">Pitchers</Link>.
        </div>
      ) : (
        <>
          <section className="mt-6">
            <h2 className="text-sm font-semibold text-foreground">Hitters</h2>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {hitters.length ? hitters.map((m) => <HitterCard key={m.mlbId} m={m} />) : (
                <div className="col-span-full text-xs text-muted-foreground">No hitter movers in your watchlist.</div>
              )}
            </div>
          </section>
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-foreground">Pitchers</h2>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {pitchers.length ? pitchers.map((m) => <PitcherCard key={m.mlbId} m={m} />) : (
                <div className="col-span-full text-xs text-muted-foreground">No pitcher movers in your watchlist.</div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
