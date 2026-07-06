import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { z } from "zod";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import {
  EXPLORE_CATEGORIES,
  getExploreLeaderboard,
  listMlbTeams,
  type ExploreGroup,
  type ExploreTimeframe,
} from "@/lib/explore.functions";

const LIMITS = [5, 10, 25, 50, 100, 500] as const;
type Limit = (typeof LIMITS)[number];

const searchSchema = z.object({
  group: fallback(z.enum(["hitting", "pitching"]), "hitting").default("hitting"),
  timeframe: fallback(z.enum(["season", "last30", "last14"]), "season").default("season"),
  cat: fallback(z.string(), "ops").default("ops"),
  team: fallback(z.number().int().nullable(), null).default(null),
  limit: fallback(z.number().int(), 25).default(25),
  q: fallback(z.string(), "").default(""),
});

function leaderboardQuery(input: {
  group: ExploreGroup;
  timeframe: ExploreTimeframe;
  categoryKey: string;
  teamId: number | null;
  limit: number;
}) {
  return queryOptions({
    queryKey: ["explore", input],
    queryFn: () =>
      getExploreLeaderboard({
        data: {
          group: input.group,
          timeframe: input.timeframe,
          categoryKey: input.categoryKey,
          teamId: input.teamId,
          limit: input.limit,
        },
      }),
    staleTime: 5 * 60 * 1000,
  });
}

const teamsQuery = queryOptions({
  queryKey: ["mlb-teams"],
  queryFn: () => listMlbTeams(),
  staleTime: 24 * 60 * 60 * 1000,
});

export const Route = createFileRoute("/_authenticated/explore")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Explore — Diamond" },
      { name: "description", content: "Official MLB leaderboards by category, team, and timeframe." },
      { property: "og:title", content: "Explore — Diamond" },
      { property: "og:description", content: "Search MLB leaderboards by category, team, and timeframe." },
    ],
  }),
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => ({
    group: search.group,
    timeframe: search.timeframe,
    categoryKey: search.cat,
    teamId: search.team,
    limit: search.limit,
  }),
  loader: ({ context, deps }) => {
    context.queryClient.ensureQueryData(leaderboardQuery(deps));
    context.queryClient.ensureQueryData(teamsQuery);
  },
  component: ExplorePage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-sm text-[var(--warm-muted)]">Couldn't load Explore: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-6">Category not found.</div>,
});

function ExplorePage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const group = search.group;
  const timeframe = search.timeframe;
  const categoryKey = search.cat;
  const teamId = search.team;
  const limit = search.limit as Limit;
  const q = search.q;

  const catsForGroup = useMemo(() => EXPLORE_CATEGORIES.filter((c) => c.group === group), [group]);
  const activeCat = catsForGroup.find((c) => c.key === categoryKey) ?? catsForGroup[0];

  const boardQ = useQuery(leaderboardQuery({ group, timeframe, categoryKey: activeCat.key, teamId, limit }));
  const teamsQ = useQuery(teamsQuery);

  const rows = boardQ.data?.rows ?? [];
  const filteredRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(needle));
  }, [rows, q]);

  const set = (partial: Partial<z.infer<typeof searchSchema>>) =>
    navigate({ search: (prev: z.infer<typeof searchSchema>) => ({ ...prev, ...partial }) as any });

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-5 md:px-6 md:py-8">
      <header className="border-b border-[var(--border)] pb-4">
        <div className="eyebrow text-[var(--primary)]">Official MLB · Server-side leaderboards</div>
        <h1 className="mt-1 text-[32px] leading-tight text-[var(--cream)] md:text-[44px]">Explore</h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--warm-muted)]">
          Search official MLB Stats API leaderboards. Filters change the actual server query — Top N is exactly the
          top N returned by the source for the selected group, timeframe, team, and category.
        </p>
      </header>

      {/* Group toggle */}
      <div className="flex flex-wrap items-center gap-2">
        {(["hitting", "pitching"] as const).map((g) => (
          <button key={g} type="button"
            onClick={() => set({ group: g, cat: g === "hitting" ? "ops" : "era" })}
            className={`mono rounded-sm border px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] transition-colors ${
              group === g
                ? "border-[var(--primary)] text-[var(--cream)]"
                : "border-[var(--border)] text-[var(--warm-muted)] hover:border-[var(--brass)] hover:text-[var(--cream)]"
            }`}
          >{g === "hitting" ? "Hitters" : "Pitchers"}</button>
        ))}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select value={timeframe} onChange={(e) => set({ timeframe: e.target.value as ExploreTimeframe })}
            className="rounded-sm border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs text-[var(--cream)]">
            <option value="season" className="bg-[var(--charcoal)]">Season</option>
            <option value="last30" className="bg-[var(--charcoal)]">Last 30 Days</option>
            <option value="last14" className="bg-[var(--charcoal)]">Last 14 Days</option>
          </select>
          <select value={teamId ?? ""} onChange={(e) => set({ team: e.target.value ? Number(e.target.value) : null })}
            className="rounded-sm border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs text-[var(--cream)]">
            <option value="" className="bg-[var(--charcoal)]">All MLB</option>
            {(teamsQ.data ?? []).map((t) => (
              <option key={t.id} value={t.id} className="bg-[var(--charcoal)]">{t.name}</option>
            ))}
          </select>
          <select value={limit} onChange={(e) => set({ limit: Number(e.target.value) as Limit })}
            className="rounded-sm border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs text-[var(--cream)]">
            {LIMITS.map((n) => <option key={n} value={n} className="bg-[var(--charcoal)]">Top {n}</option>)}
          </select>
          <input
            value={q} onChange={(e) => set({ q: e.target.value })}
            placeholder="Search player…"
            className="rounded-sm border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs text-[var(--cream)] placeholder:text-[var(--warm-muted)]"
          />
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex flex-wrap gap-1.5">
        {catsForGroup.map((c) => (
          <button key={c.key} type="button"
            onClick={() => set({ cat: c.key })}
            className={`rounded-sm border px-2.5 py-1 text-[11px] transition-colors ${
              c.key === activeCat.key
                ? "border-[var(--primary)] text-[var(--cream)]"
                : "border-[var(--border)] text-[var(--warm-muted)] hover:border-[var(--brass)] hover:text-[var(--cream)]"
            }`}
          >{c.label}</button>
        ))}
      </div>

      {/* Meta */}
      <div className="mono flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] uppercase tracking-[0.18em] text-[var(--warm-muted)]">
        <span>{activeCat.label}</span>
        <span>{boardQ.data?.windowLabel ?? "…"}</span>
        <span>Source · MLB Stats API</span>
        {boardQ.data ? <span>Fetched {new Date(boardQ.data.fetchedAt).toLocaleTimeString()}</span> : null}
        {boardQ.isFetching ? <span className="text-[var(--brass)]">Refreshing…</span> : null}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-sm border border-[var(--border)]">
        <table className="w-full text-xs">
          <thead className="bg-[color-mix(in_oklab,var(--charcoal)_90%,transparent)] text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">
            <tr>
              <th className="px-2 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Player</th>
              <th className="px-2 py-2 text-left">Team</th>
              <th className="px-2 py-2 text-left">Pos</th>
              <th className="px-2 py-2 text-right">{activeCat.label}</th>
              <th className="px-2 py-2 text-right">G</th>
              {group === "hitting"
                ? <th className="px-2 py-2 text-right">PA</th>
                : <th className="px-2 py-2 text-right">IP</th>}
            </tr>
          </thead>
          <tbody>
            {boardQ.isLoading ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-[var(--warm-muted)]">Loading…</td></tr>
            ) : boardQ.error ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-rose-300">{(boardQ.error as Error).message}</td></tr>
            ) : filteredRows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-[var(--warm-muted)]">
                {q ? `No players match “${q}”.` : "No rows returned by MLB Stats API for this query."}
              </td></tr>
            ) : filteredRows.map((r) => (
              <tr key={`${r.mlbId}:${r.rank}`} className="border-t border-[var(--border)] hover:bg-[color-mix(in_oklab,var(--charcoal)_75%,transparent)]">
                <td className="px-2 py-1.5 text-[var(--warm-muted)] mono">{r.rank}</td>
                <td className="px-2 py-1.5 font-semibold">
                  <Link to="/player/$mlbId" params={{ mlbId: String(r.mlbId) }} className="text-[var(--cream)] hover:text-[var(--brass)]">
                    {r.name}
                  </Link>
                </td>
                <td className="px-2 py-1.5 mono text-[var(--warm-muted)]">{r.team ?? "—"}</td>
                <td className="px-2 py-1.5 mono text-[var(--warm-muted)]">{r.position ?? "—"}</td>
                <td className="px-2 py-1.5 mono text-right tabular-nums text-[var(--cream)]">{r.value}</td>
                <td className="px-2 py-1.5 mono text-right tabular-nums text-[var(--warm-muted)]">{r.games ?? "—"}</td>
                <td className="px-2 py-1.5 mono text-right tabular-nums text-[var(--warm-muted)]">
                  {group === "hitting" ? (r.pa ?? "—") : (r.ip ?? "—")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[10px] text-[var(--warm-muted)]">
        Rate stats (AVG/OBP/SLG/OPS/ERA/WHIP) use MLB’s Qualified player pool. Counting stats include every player
        returned by the source for the selected window.
      </div>
    </main>
  );
}
