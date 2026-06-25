import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { getDiamondScores, type DiamondHitterCard, type DiamondPitcherCard } from "@/lib/projections.functions";

type PropType = "hit" | "tb" | "hr" | "rbi" | "sb" | "win" | "qs";

type PropRow = {
  key: string;
  player_name: string;
  mlb_id: number | null;
  team_abbrev: string;
  opp_abbrev: string;
  game_id: string;
  batting_order: number | null;
  propType: PropType;
  label: string;
  line: string;
  probability: number;
  diamond_score: number | null;
  lineup_badge: string;
  is_pitcher: boolean;
};

const PROP_META: Record<PropType, { label: string; line: string; hero: string }> = {
  hit:  { label: "Hit",         line: "1+ H",   hero: "Safest Hit" },
  tb:   { label: "Total Bases", line: "2+ TB",  hero: "Top Total Bases" },
  hr:   { label: "Home Run",    line: "1+ HR",  hero: "Top HR" },
  rbi:  { label: "RBI",         line: "1+ RBI", hero: "Top RBI" },
  sb:   { label: "Stolen Base", line: "1+ SB",  hero: "Top SB" },
  win:  { label: "Pitcher Win", line: "W",      hero: "Top Pitcher Win" },
  qs:   { label: "Quality Start", line: "QS",   hero: "Top Quality Start" },
};

const searchSchema = z.object({
  date: z.string().optional(),
  prop: fallback(z.enum(["all", "hit", "tb", "hr", "rbi", "sb", "win", "qs"]), "all").default("all"),
  min: fallback(z.coerce.number().min(0).max(100), 60).default(60),
  team: z.string().optional(),
  sort: fallback(z.enum(["probability", "diamond"]), "probability").default("probability"),
});

function diamondQuery(date: string | undefined) {
  return queryOptions({
    queryKey: ["diamond-scores", date ?? "today"],
    queryFn: () => getDiamondScores({ data: date ? { date } : {} }),
    staleTime: 60_000,
    retry: 2,
  });
}

export const Route = createFileRoute("/top-props")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Top Props — Diamond" },
      { name: "description", content: "Highest-probability player props for today's MLB slate from the Diamond Engine." },
      { property: "og:title", content: "Top Props — Diamond" },
      { property: "og:description", content: "The strongest hitter and pitcher props ranked by Diamond Engine probability." },
    ],
  }),
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => ({ date: search.date }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(diamondQuery(deps.date)),
  component: TopPropsPage,
  errorComponent: ({ error, reset }) => {
    const router = useRouter();
    return (
      <div className="p-8 text-sm text-muted-foreground space-y-2">
        <div>Couldn't load Top Props: {error.message}</div>
        <button
          onClick={() => { reset(); router.invalidate(); }}
          className="rounded-md border border-border/60 px-3 py-1 text-xs uppercase tracking-widest"
        >Retry</button>
      </div>
    );
  },
  notFoundComponent: () => <div className="p-8">Nothing here.</div>,
});

function badgeLabel(b: string): string {
  if (b === "official") return "Official";
  if (b === "locked") return "Locked";
  if (b === "aggregated") return "Aggregated";
  return "Projected";
}

function flattenHitter(h: DiamondHitterCard): PropRow[] {
  const base = {
    player_name: h.player_name,
    mlb_id: h.mlb_id,
    team_abbrev: h.team_abbrev,
    opp_abbrev: h.opp_abbrev,
    game_id: h.game_id,
    batting_order: h.batting_order,
    diamond_score: h.diamond_score,
    lineup_badge: badgeLabel(h.badge),
    is_pitcher: false,
  };
  const rows: PropRow[] = [];
  const entries: Array<[PropType, number | null]> = [
    ["hit", h.hit_probability],
    ["tb",  h.total_base_probability],
    ["hr",  h.hr_probability],
    ["rbi", h.rbi_probability],
    ["sb",  h.sb_probability],
  ];
  for (const [propType, prob] of entries) {
    if (prob == null) continue;
    const meta = PROP_META[propType];
    rows.push({
      ...base,
      key: `${h.player_id}:${h.game_id}:${h.model_version}:${propType}`,
      propType, label: meta.label, line: meta.line,
      probability: prob,
    });
  }
  return rows;
}

function flattenPitcher(p: DiamondPitcherCard): PropRow[] {
  const base = {
    player_name: p.player_name,
    mlb_id: p.mlb_id,
    team_abbrev: p.team_abbrev,
    opp_abbrev: p.opp_abbrev,
    game_id: p.game_id,
    batting_order: null,
    diamond_score: p.diamond_score,
    lineup_badge: badgeLabel(p.badge),
    is_pitcher: true,
  };
  const rows: PropRow[] = [];
  if (p.pitcher_win_probability != null) {
    rows.push({ ...base, key: `${p.player_id}:${p.game_id}:${p.model_version}:win`,
      propType: "win", label: PROP_META.win.label, line: PROP_META.win.line, probability: p.pitcher_win_probability });
  }
  if (p.quality_start_probability != null) {
    rows.push({ ...base, key: `${p.player_id}:${p.game_id}:${p.model_version}:qs`,
      propType: "qs", label: PROP_META.qs.label, line: PROP_META.qs.line, probability: p.quality_start_probability });
  }
  return rows;
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function tierClasses(p: number): string {
  if (p >= 0.80) return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (p >= 0.65) return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  if (p >= 0.50) return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-zinc-500/15 text-zinc-300 border-zinc-500/30";
}

function TopPropsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(diamondQuery(search.date));

  const setSearch = (patch: Record<string, string | number | undefined>) =>
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }), replace: true });

  const allRows = useMemo<PropRow[]>(() => {
    const rows: PropRow[] = [];
    for (const h of data.hitters) rows.push(...flattenHitter(h));
    for (const p of data.pitchers) rows.push(...flattenPitcher(p));
    return rows;
  }, [data.hitters, data.pitchers]);

  // Best-of-the-day strip: highest probability per prop type
  const heroes = useMemo(() => {
    const out: Array<{ propType: PropType; row: PropRow | null }> = [];
    const types: PropType[] = ["hit", "tb", "hr", "rbi", "sb", "win", "qs"];
    for (const t of types) {
      const best = allRows
        .filter((r) => r.propType === t)
        .sort((a, b) => b.probability - a.probability)[0];
      out.push({ propType: t, row: best ?? null });
    }
    return out;
  }, [allRows]);

  const filtered = useMemo(() => {
    let rows = allRows.slice();
    if (search.prop !== "all") rows = rows.filter((r) => r.propType === search.prop);
    if (search.team) rows = rows.filter((r) => r.team_abbrev === search.team);
    rows = rows.filter((r) => r.probability * 100 >= search.min);
    if (search.sort === "diamond") {
      rows.sort((a, b) => (b.diamond_score ?? -1) - (a.diamond_score ?? -1));
    } else {
      rows.sort((a, b) => b.probability - a.probability);
    }
    return rows.slice(0, 200);
  }, [allRows, search.prop, search.team, search.min, search.sort]);

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) if (r.team_abbrev) set.add(r.team_abbrev);
    return Array.from(set).sort();
  }, [allRows]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-bold tracking-wide">Top Props</h1>
        <p className="text-sm text-muted-foreground">
          Highest-probability plays from today's Diamond Engine projections. Date: {data.date}
        </p>
      </header>

      {/* Hero strip */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        {heroes.map(({ propType, row }) => (
          <div key={propType} className="rounded-lg border border-border/60 bg-card/40 p-3">
            <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {PROP_META[propType].hero}
            </div>
            {row ? (
              <Link
                to={row.mlb_id ? "/players/$playerId" : "/top-props"}
                params={row.mlb_id ? { playerId: String(row.mlb_id) } : undefined}
                className="mt-1 block"
              >
                <div className="text-sm font-semibold leading-tight truncate">{row.player_name}</div>
                <div className="mono text-[10px] text-muted-foreground">
                  {row.team_abbrev} vs {row.opp_abbrev}
                </div>
                <div className={`mt-1 inline-block rounded border px-1.5 py-0.5 text-xs font-bold ${tierClasses(row.probability)}`}>
                  {pct(row.probability)} · {PROP_META[propType].line}
                </div>
              </Link>
            ) : (
              <div className="mt-2 text-xs text-muted-foreground">No data</div>
            )}
          </div>
        ))}
      </section>

      {/* Filters */}
      <section className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/30 p-3">
        <div className="flex items-center gap-1">
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Prop</span>
          <select
            value={search.prop}
            onChange={(e) => setSearch({ prop: e.target.value })}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
          >
            <option value="all">All</option>
            <option value="hit">Hit 1+</option>
            <option value="tb">TB 2+</option>
            <option value="hr">HR 1+</option>
            <option value="rbi">RBI 1+</option>
            <option value="sb">SB 1+</option>
            <option value="win">Pitcher Win</option>
            <option value="qs">Quality Start</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Team</span>
          <select
            value={search.team ?? ""}
            onChange={(e) => setSearch({ team: e.target.value || undefined })}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
          >
            <option value="">All teams</option>
            {teams.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Min %</span>
          <input
            type="range" min={0} max={95} step={5}
            value={search.min}
            onChange={(e) => setSearch({ min: Number(e.target.value) })}
            className="w-32"
          />
          <span className="mono w-10 text-xs">{search.min}%</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Sort</span>
          <select
            value={search.sort}
            onChange={(e) => setSearch({ sort: e.target.value })}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
          >
            <option value="probability">Probability</option>
            <option value="diamond">Diamond Score</option>
          </select>
        </div>
        <div className="ml-auto mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {filtered.length} shown · {allRows.length} total
        </div>
      </section>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-border/60 bg-card/30 p-6 text-center text-sm text-muted-foreground">
          No props match your filters. Lower the minimum %, or
          <Link to="/lineup-status" className="ml-1 underline">run today's pipeline</Link>.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-card/50 text-muted-foreground">
              <tr className="mono text-[10px] uppercase tracking-widest">
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Player</th>
                <th className="px-3 py-2 text-left">Matchup</th>
                <th className="px-3 py-2 text-left">Prop</th>
                <th className="px-3 py-2 text-right">Prob</th>
                <th className="px-3 py-2 text-right">DS</th>
                <th className="px-3 py-2 text-left">Lineup</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.key} className="border-t border-border/40 hover:bg-secondary/40">
                  <td className="px-3 py-2 mono text-xs text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2">
                    {r.mlb_id ? (
                      <Link to="/players/$playerId" params={{ playerId: String(r.mlb_id) }} className="font-medium hover:underline">
                        {r.player_name}
                      </Link>
                    ) : (
                      <span className="font-medium">{r.player_name}</span>
                    )}
                    {r.batting_order ? (
                      <span className="mono ml-2 text-[10px] text-muted-foreground">#{r.batting_order}</span>
                    ) : null}
                    {r.is_pitcher ? <span className="mono ml-2 text-[10px] text-edge">SP</span> : null}
                  </td>
                  <td className="px-3 py-2 mono text-xs">{r.team_abbrev} <span className="text-muted-foreground">vs</span> {r.opp_abbrev}</td>
                  <td className="px-3 py-2">{r.label} <span className="mono text-[10px] text-muted-foreground">{r.line}</span></td>
                  <td className="px-3 py-2 text-right">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-bold ${tierClasses(r.probability)}`}>
                      {pct(r.probability)}
                    </span>
                  </td>
                  <td className="px-3 py-2 mono text-right text-xs">{r.diamond_score != null ? Math.round(r.diamond_score) : "—"}</td>
                  <td className="px-3 py-2 mono text-[10px] text-muted-foreground">{r.lineup_badge}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
