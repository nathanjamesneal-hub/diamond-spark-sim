import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import {
  getDiamondScores,
  type DiamondHitterCard,
  type DiamondPitcherCard,
} from "@/lib/projections.functions";
import { shiftIsoDate } from "@/lib/timezone";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const hitterSorts = ["diamond", "hit", "hr", "rbi", "sb"] as const;
const pitcherSorts = ["diamond", "k"] as const;

const searchSchema = z.object({
  date: z.string().optional(),
  tab: fallback(z.enum(["hitters", "pitchers"]), "hitters").default("hitters"),
  sort: fallback(z.enum(["diamond", "hit", "hr", "rbi", "sb", "k"]), "diamond").default("diamond"),
  game: z.string().optional(),
  team: z.string().optional(),
  version: z.string().optional(),
});

function diamondQuery(date: string | undefined) {
  return queryOptions({
    queryKey: ["diamond-scores", date ?? "today"],
    queryFn: () => getDiamondScores({ data: date ? { date } : {} }),
    staleTime: 60_000,
  });
}

export const Route = createFileRoute("/diamond-scores")({
  head: () => ({
    meta: [
      { title: "Diamond Scores — Diamond" },
      { name: "description", content: "Diamond Engine projections for today's hitters and pitchers." },
      { property: "og:title", content: "Diamond Scores — Diamond" },
      { property: "og:description", content: "Hitter and pitcher Diamond Scores with tier badges." },
    ],
  }),
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => ({ date: search.date }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(diamondQuery(deps.date)),
  component: DiamondScoresPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-muted-foreground">Couldn't load Diamond Scores: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">Nothing here.</div>,
});

function DiamondScoresPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(diamondQuery(search.date));

  const filteredHitters = useMemo(() => {
    let rows = data.hitters.slice();
    if (search.game) rows = rows.filter((r) => r.game_id === search.game);
    if (search.team) rows = rows.filter((r) => r.team_abbrev === search.team);
    if (search.version) rows = rows.filter((r) => r.model_version === search.version);
    rows.sort(sorterHitter(search.sort));
    return rows;
  }, [data.hitters, search.game, search.team, search.version, search.sort]);

  const filteredPitchers = useMemo(() => {
    let rows = data.pitchers.slice();
    if (search.game) rows = rows.filter((r) => r.game_id === search.game);
    if (search.team) rows = rows.filter((r) => r.team_abbrev === search.team);
    if (search.version) rows = rows.filter((r) => r.model_version === search.version);
    rows.sort(sorterPitcher(search.sort));
    return rows;
  }, [data.pitchers, search.game, search.team, search.version, search.sort]);

  const setSearch = (patch: Record<string, string | undefined>) =>
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) });


  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">Diamond Scores</div>
          <h1 className="font-display text-3xl font-bold tracking-tight">{data.date}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Active model: <span className="mono">{data.activeVersion ?? "—"}</span> · Display-only view of stored projections.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateBtn onClick={() => setSearch({ date: shiftIsoDate(data.date, -1) })}>← Prev</DateBtn>
          <DateBtn onClick={() => setSearch({ date: undefined })}>Today</DateBtn>
          <DateBtn onClick={() => setSearch({ date: shiftIsoDate(data.date, 1) })}>Next →</DateBtn>
        </div>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <FilterSelect
          label="Sort"
          value={search.sort}
          onChange={(v) => setSearch({ sort: v })}
          options={[
            { v: "diamond", l: "Diamond Score" },
            ...(search.tab === "pitchers"
              ? [{ v: "k", l: "K projection (n/a)" }]
              : [
                  { v: "hit", l: "Hit %" },
                  { v: "hr", l: "HR %" },
                  { v: "rbi", l: "RBI %" },
                  { v: "sb", l: "SB %" },
                ]),
          ]}
        />
        <FilterSelect
          label="Game"
          value={search.game ?? "all"}
          onChange={(v) => setSearch({ game: v === "all" ? undefined : v })}
          options={[{ v: "all", l: "All games" }, ...data.games.map((g) => ({ v: g.id, l: g.label }))]}
        />
        <FilterSelect
          label="Team"
          value={search.team ?? "all"}
          onChange={(v) => setSearch({ team: v === "all" ? undefined : v })}
          options={[{ v: "all", l: "All teams" }, ...data.teams.map((t) => ({ v: t.abbrev, l: t.abbrev }))]}
        />
        <FilterSelect
          label="Model"
          value={search.version ?? "all"}
          onChange={(v) => setSearch({ version: v === "all" ? undefined : v })}
          options={[
            { v: "all", l: "All versions" },
            ...data.modelVersions.map((v) => ({ v, l: v })),
          ]}
        />
      </div>

      <Tabs
        value={search.tab}
        onValueChange={(v) => setSearch({ tab: v, sort: "diamond" })}
        className="w-full"
      >
        <TabsList>
          <TabsTrigger value="hitters">Hitter Cards ({filteredHitters.length})</TabsTrigger>
          <TabsTrigger value="pitchers">Pitcher Cards ({filteredPitchers.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="hitters" className="mt-4">
          {filteredHitters.length === 0 ? (
            <Empty msg="No hitter projections for this date/filter yet. Run the Diamond Engine after Lineups are imported." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredHitters.map((h) => (
                <HitterCardView key={`${h.player_id}:${h.game_id}:${h.model_version}`} h={h} />
              ))}
            </div>
          )}
          <MissingFields title="Hitter fields not yet stored in database" fields={data.missingHitterFields} />
        </TabsContent>

        <TabsContent value="pitchers" className="mt-4">
          {filteredPitchers.length === 0 ? (
            <Empty msg="No pitcher projections for this date/filter yet." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredPitchers.map((p) => (
                <PitcherCardView key={`${p.player_id}:${p.game_id}:${p.model_version}`} p={p} />
              ))}
            </div>
          )}
          <MissingFields title="Pitcher fields not yet stored in database" fields={data.missingPitcherFields} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- sorters ----------
function num(n: number | null | undefined): number {
  return n == null ? -Infinity : n;
}
function sorterHitter(k: (typeof hitterSorts)[number] | "k") {
  return (a: DiamondHitterCard, b: DiamondHitterCard) => {
    switch (k) {
      case "hit": return num(b.hit_probability) - num(a.hit_probability);
      case "hr": return num(b.hr_probability) - num(a.hr_probability);
      case "rbi": return num(b.rbi_probability) - num(a.rbi_probability);
      case "sb": return num(b.sb_probability) - num(a.sb_probability);
      default: return num(b.diamond_score) - num(a.diamond_score);
    }
  };
}
function sorterPitcher(_k: (typeof pitcherSorts)[number] | string) {
  return (a: DiamondPitcherCard, b: DiamondPitcherCard) =>
    num(b.diamond_score) - num(a.diamond_score);
}

// ---------- presentational ----------
function tier(score: number | null): { label: string; cls: string } {
  if (score == null) return { label: "—", cls: "bg-secondary text-muted-foreground" };
  if (score >= 95) return { label: "ELITE", cls: "bg-primary/20 text-primary" };
  if (score >= 90) return { label: "A", cls: "bg-primary/15 text-primary" };
  if (score >= 85) return { label: "B", cls: "bg-edge/15 text-edge" };
  if (score >= 80) return { label: "C", cls: "bg-secondary text-foreground" };
  return { label: "PASS", cls: "bg-secondary text-muted-foreground" };
}

function pct(n: number | null): string {
  if (n == null) return "—";
  const v = n <= 1 ? n * 100 : n;
  return `${v.toFixed(0)}%`;
}
function score(n: number | null): string {
  return n == null ? "—" : n.toFixed(0);
}

function HitterCardView({ h }: { h: DiamondHitterCard }) {
  const t = tier(h.diamond_score);
  return (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          {h.mlb_id != null ? (
            <Link
              to="/players/$playerId"
              params={{ playerId: String(h.mlb_id) }}
              className="block truncate font-display text-base font-bold hover:text-primary"
            >
              {h.player_name}
            </Link>
          ) : (
            <div className="block truncate font-display text-base font-bold">{h.player_name}</div>
          )}
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {h.team_abbrev} vs {h.opp_abbrev}
            {h.batting_order ? ` · #${h.batting_order}` : ""} · {h.lineup_status}
          </div>
        </div>
        <span className={`mono rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${t.cls}`}>
          {t.label}
        </span>
      </div>

      <div className="mb-3 flex items-end justify-between border-b border-border/60 pb-3">
        <div>
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Diamond</div>
          <div className="font-display text-3xl font-bold tabular-nums text-primary">{score(h.diamond_score)}</div>
        </div>
        <div className="text-right">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Confidence</div>
          <div className="mono text-sm tabular-nums">{pct(h.confidence)}</div>
          <div className="mono mt-1 text-[10px] text-muted-foreground">{h.model_version}</div>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-5 gap-1 text-center">
        <Mini label="Contact" v={score(h.contact_score)} />
        <Mini label="Power" v={score(h.power_score)} />
        <Mini label="Speed" v={score(h.speed_score)} />
        <Mini label="PG" v={score(h.pitcher_grade)} />
        <Mini label="MG" v={score(h.matchup_grade)} />
      </div>

      <div className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
        <Stat label="Hit" v={pct(h.hit_probability)} />
        <Stat label="Hit 0.5+" v="n/a" muted />
        <Stat label="Hit 1.5+" v="n/a" muted />
        <Stat label="TB proj" v="n/a" muted />
        <Stat label="TB %" v={pct(h.total_base_probability)} />
        <Stat label="TB 0.5+" v="n/a" muted />
        <Stat label="TB 1.5+" v="n/a" muted />
        <Stat label="TB 2.5+" v="n/a" muted />
        <Stat label="HR" v={pct(h.hr_probability)} />
        <Stat label="RBI" v={pct(h.rbi_probability)} />
        <Stat label="Run" v={pct(h.run_probability)} />
        <Stat label="SB" v={pct(h.sb_probability)} />
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {h.inputs_narrative ?? buildHitterReason(h)}
      </p>

      {h.mlb_game_id ? (
        <Link
          to="/matchups/$gamePk"
          params={{ gamePk: String(h.mlb_game_id) }}
          className="mono mt-3 inline-block text-[10px] uppercase tracking-widest text-edge hover:underline"
        >
          View matchup →
        </Link>
      ) : null}
    </div>
  );
}

function PitcherCardView({ p }: { p: DiamondPitcherCard }) {
  const t = tier(p.diamond_score);
  return (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          {p.mlb_id != null ? (
            <Link
              to="/players/$playerId"
              params={{ playerId: String(p.mlb_id) }}
              className="block truncate font-display text-base font-bold hover:text-primary"
            >
              {p.player_name}
            </Link>
          ) : (
            <div className="block truncate font-display text-base font-bold">{p.player_name}</div>
          )}
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {p.team_abbrev} vs {p.opp_abbrev}
            {p.game_status ? ` · ${p.game_status}` : ""}
          </div>
        </div>
        <span className={`mono rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${t.cls}`}>
          {t.label}
        </span>
      </div>

      <div className="mb-3 flex items-end justify-between border-b border-border/60 pb-3">
        <div>
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Diamond Pitcher</div>
          <div className="font-display text-3xl font-bold tabular-nums text-primary">{score(p.diamond_score)}</div>
        </div>
        <div className="text-right">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Confidence</div>
          <div className="mono text-sm tabular-nums">{pct(p.confidence)}</div>
          <div className="mono mt-1 text-[10px] text-muted-foreground">{p.model_version}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
        <Stat label="K proj" v="n/a" muted />
        <Stat label="K 3.5+" v="n/a" muted />
        <Stat label="K 4.5+" v="n/a" muted />
        <Stat label="K 5.5+" v="n/a" muted />
        <Stat label="K 6.5+" v="n/a" muted />
        <Stat label="Outs" v={p.projected_outs == null ? "—" : p.projected_outs.toFixed(1)} />
        <Stat label="QS %" v={pct(p.quality_start_probability)} />
        <Stat label="Win %" v={pct(p.pitcher_win_probability)} />
        <Stat label="ER proj" v="n/a" muted />
        <Stat label="ER<2.5" v="n/a" muted />
        <Stat label="H allow" v="n/a" muted />
        <Stat label="BB proj" v="n/a" muted />
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {p.inputs_narrative ?? buildPitcherReason(p)}
      </p>

      {p.mlb_game_id ? (
        <Link
          to="/matchups/$gamePk"
          params={{ gamePk: String(p.mlb_game_id) }}
          className="mono mt-3 inline-block text-[10px] uppercase tracking-widest text-edge hover:underline"
        >
          View matchup →
        </Link>
      ) : null}
    </div>
  );
}

function buildHitterReason(h: DiamondHitterCard): string {
  const parts: string[] = [];
  if ((h.contact_score ?? 0) >= 85) parts.push(`elite contact (${score(h.contact_score)})`);
  if ((h.power_score ?? 0) >= 85) parts.push(`plus power (${score(h.power_score)})`);
  if ((h.speed_score ?? 0) >= 85) parts.push(`plus speed (${score(h.speed_score)})`);
  if ((h.matchup_grade ?? 0) >= 70) parts.push("favorable matchup");
  else if ((h.matchup_grade ?? 100) < 40) parts.push("tough matchup");
  if (parts.length === 0) return "Score reflects league-average sub-scores in this matchup.";
  return "Driven by " + parts.join(", ") + ".";
}

function buildPitcherReason(p: DiamondPitcherCard): string {
  const parts: string[] = [];
  if ((p.quality_start_probability ?? 0) >= 0.5) parts.push(`QS likely (${pct(p.quality_start_probability)})`);
  if ((p.projected_outs ?? 0) >= 18) parts.push(`projects ${p.projected_outs?.toFixed(1)} outs`);
  if ((p.pitcher_win_probability ?? 0) >= 0.5) parts.push(`win edge ${pct(p.pitcher_win_probability)}`);
  if (parts.length === 0) return "Score reflects neutral expected workload and run prevention.";
  return parts.join(" · ");
}

function Mini({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded-md bg-secondary/40 py-1">
      <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mono text-sm font-bold tabular-nums">{v}</div>
    </div>
  );
}

function Stat({ label, v, muted }: { label: string; v: string; muted?: boolean }) {
  return (
    <div className={`flex items-center justify-between rounded px-2 py-1 ${muted ? "bg-secondary/20" : "bg-secondary/40"}`}>
      <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className={`mono tabular-nums ${muted ? "text-muted-foreground" : "text-foreground"}`}>{v}</span>
    </div>
  );
}

function MissingFields({ title, fields }: { title: string; fields: string[] }) {
  if (fields.length === 0) return null;
  return (
    <details className="mt-6 rounded-md border border-border/60 bg-card/40 p-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer mono uppercase tracking-widest text-[10px]">{title}</summary>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {fields.map((f) => (
          <li key={f} className="mono">· {f} — not stored yet</li>
        ))}
      </ul>
    </details>
  );
}

function FilterSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <label className="block">
      <span className="mono mb-1 block text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function DateBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mono rounded-md border border-border/60 px-2.5 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-card/40 p-8 text-center text-sm text-muted-foreground">
      {msg}
    </div>
  );
}
