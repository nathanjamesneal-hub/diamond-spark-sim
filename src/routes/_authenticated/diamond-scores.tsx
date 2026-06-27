import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ForecastsTabBar } from "@/components/forecasts-tab-bar";
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
import { PrimaryMetricsRow } from "@/components/diamond/primary-metrics-row";
import { SimDetails } from "@/components/diamond/sim-details";
import { PredictionDrivers } from "@/components/diamond/prediction-drivers";
import { WhyTheModelLikesThis } from "@/components/diamond/why-model-likes-this";
import { SimMethodologyTooltip } from "@/components/diamond/sim-methodology-tooltip";


import { ForecastBoard } from "@/components/diamond/forecast-board/forecast-board";

const hitterSorts = ["diamond", "hit", "hr", "rbi", "sb"] as const;
const pitcherSorts = ["diamond", "k"] as const;

const searchSchema = z.object({
  date: z.string().optional(),
  view: fallback(z.enum(["board", "cards"]), "board").default("board"),
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

export const Route = createFileRoute("/_authenticated/diamond-scores")({
  ssr: false,
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
    <>
      <ForecastsTabBar />
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">Diamond Scores</div>
          <h1 className="font-display text-3xl font-bold tracking-tight">{data.date}</h1>
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            MLB simulation & projection engine · active model{" "}
            <span className="mono">{data.activeVersion ?? "—"}</span>
            <SimMethodologyTooltip className="ml-1" />
          </p>

          <div className="mt-2 flex items-center gap-2">
            <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Lineups · {data.slateConfirmed} / {data.slateTotal} confirmed
            </div>
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-edge transition-all"
                style={{ width: data.slateTotal ? `${(data.slateConfirmed / data.slateTotal) * 100}%` : "0%" }}
              />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <DateBtn onClick={() => setSearch({ date: shiftIsoDate(data.date, -1) })}>← Prev</DateBtn>
          <DateBtn onClick={() => setSearch({ date: undefined })}>Today</DateBtn>
          <DateBtn onClick={() => setSearch({ date: shiftIsoDate(data.date, 1) })}>Next →</DateBtn>
        </div>
      </div>


      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">View</span>
        {(["board", "cards"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setSearch({ view: v })}
            className={`mono rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest transition-colors ${
              search.view === v
                ? "border-primary/60 bg-primary/15 text-primary"
                : "border-border/60 bg-card/50 text-muted-foreground hover:text-foreground"
            }`}
          >{v === "board" ? "Forecast Board" : "Cards"}</button>
        ))}
      </div>

      {search.view === "board" ? (
        <ForecastBoard payload={data} />
      ) : (
      <>
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
            <Empty msg="No hitter projections for this date/filter yet." withPipelineLink />
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
            <Empty msg="No pitcher projections for this date/filter yet." withPipelineLink />
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
      </>
      )}
    </div>
    </>
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
            {h.batting_order ? ` · #${h.batting_order}` : ""}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            <LineupBadge badge={h.badge} source={h.lineup_source} confidence={h.lineup_confidence} />
          </div>
        </div>
        <span className={`mono rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${t.cls}`}>
          {t.label}
        </span>
      </div>


      {/* Primary metrics: Diamond · Mean · Sim Prob · Confidence · Edge */}
      <div className="mb-3">
        <PrimaryMetricsRow
          diamondScore={h.diamond_score}
          meanProjection={null}
          meanLabel="Mean Hits"
          probability={h.hit_probability}
          probabilityLabel="Hit Probability"
          confidence={h.confidence}
          edge={null}
        />
      </div>

      {/* Simulation details — per-batter Monte Carlo distribution is computed live
          on the matchup page; persisted projections only expose probabilities,
          so mean/median/stdev render as "—" placeholders here. */}
      <SimDetails mean={null} median={null} stdev={null} percentile90={null} />

      {/* Existing sub-score detail kept for transparency */}
      <div className="mb-2 mt-3 grid grid-cols-5 gap-1 text-center">
        <Mini label="Contact" v={score(h.contact_score)} />
        <Mini label="Power" v={score(h.power_score)} />
        <Mini label="Speed" v={score(h.speed_score)} />
        <Mini label="PG" v={score(h.pitcher_grade)} />
        <Mini label="MG" v={score(h.matchup_grade)} />
      </div>

      <div className="mb-3 grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
        <Stat label="Hit %" v={pct(h.hit_probability)} />
        <Stat label="TB %" v={pct(h.total_base_probability)} />
        <Stat label="HR %" v={pct(h.hr_probability)} />
        <Stat label="RBI %" v={pct(h.rbi_probability)} />
        <Stat label="Run %" v={pct(h.run_probability)} />
        <Stat label="SB %" v={pct(h.sb_probability)} />
      </div>

      <div className="mb-2">
        <PredictionDrivers
          battingOrder={h.batting_order}
          opposingPitcher={null}
          parkFactor={null}
          platoonAdvantage={null}
          bullpenAdjustment={null}
          weather={null}
          recentForm={null}
          lineupStatus={h.lineup_status}
        />
      </div>

      <div className="mb-2">
        <WhyTheModelLikesThis
          diamondScore={h.diamond_score}
          meanProjection={null}
          probability={h.hr_probability ?? h.hit_probability}
          probabilityLabel={h.hr_probability != null ? "HR Probability" : "Hit Probability"}
          parkFactor={null}
          opposingPitcher={null}
          battingOrder={h.batting_order ?? null}
          weather={null}
          recentForm={null}
        />
      </div>

      <p className="text-xs text-muted-foreground">
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

      {/* Primary metrics: Diamond · Mean Outs · QS Prob · Confidence · Edge */}
      <div className="mb-3">
        <PrimaryMetricsRow
          diamondScore={p.diamond_score}
          meanProjection={p.projected_outs}
          meanLabel="Mean Outs"
          meanFractionDigits={1}
          probability={p.quality_start_probability}
          probabilityLabel="QS Probability"
          confidence={p.confidence}
          edge={null}
        />
      </div>

      <SimDetails mean={p.projected_outs} median={null} stdev={null} percentile90={null} fractionDigits={1} />

      <div className="mb-3 mt-3 grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
        <Stat label="Outs" v={p.projected_outs == null ? "—" : p.projected_outs.toFixed(1)} />
        <Stat label="QS %" v={pct(p.quality_start_probability)} />
        <Stat label="Win %" v={pct(p.pitcher_win_probability)} />
        <NotPersistedStat label="K proj" />
        <NotPersistedStat label="ER proj" />
        <NotPersistedStat label="H allow" />
      </div>

      <div className="mb-2">
        <PredictionDrivers
          battingOrder={null}
          opposingPitcher={`vs ${p.opp_abbrev || "—"}`}
          parkFactor={null}
          platoonAdvantage={null}
          bullpenAdjustment={null}
          weather={null}
          recentForm={null}
          lineupStatus={p.game_status}
        />
      </div>

      <div className="mb-2">
        <WhyTheModelLikesThis
          diamondScore={p.diamond_score}
          meanProjection={p.projected_outs}
          meanLabel="Mean Outs"
          probability={p.quality_start_probability}
          probabilityLabel="QS Probability"
        />
      </div>


      {p.pitcher_components && p.pitcher_components.length > 0 ? (
        <div className="mt-3 rounded-md border border-border/50 bg-secondary/30 p-2">
          <div className="mono mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
            <span>Score components</span>
            {p.pitcher_fallbacks && p.pitcher_fallbacks.length > 0 ? (
              <span className="text-[9px] italic text-muted-foreground/80">
                {p.pitcher_fallbacks.length} fallback
              </span>
            ) : null}
          </div>
          <ul className="grid gap-0.5">
            {p.pitcher_components.map((c) => (
              <li
                key={c.key}
                className="flex items-center justify-between gap-2 text-[11px]"
                title={c.reason ?? (c.source === "fallback" ? "Neutral 50 — input not available" : "")}
              >
                <span className="mono truncate text-muted-foreground">
                  {c.label} <span className="opacity-60">×{c.weight.toFixed(2)}</span>
                </span>
                <span className="mono flex items-center gap-1.5 tabular-nums">
                  <span className={c.source === "fallback" ? "text-muted-foreground italic" : "text-foreground"}>
                    {c.value}
                  </span>
                  {c.source === "fallback" ? (
                    <span className="rounded bg-secondary px-1 text-[9px] uppercase tracking-widest text-muted-foreground">fb</span>
                  ) : c.source === "stat" ? (
                    <span className="rounded bg-primary/15 px-1 text-[9px] uppercase tracking-widest text-primary">stat</span>
                  ) : (
                    <span className="rounded bg-edge/15 px-1 text-[9px] uppercase tracking-widest text-edge">env</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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

function LineupBadge({
  badge, source, confidence,
}: {
  badge: "official" | "aggregated" | "low_confidence" | "locked";
  source: string | null;
  confidence: number | null;
}) {
  const map = {
    official: { label: "Official MLB", cls: "bg-edge/20 text-edge", icon: "🟢" },
    aggregated: { label: source ? `Aggregated · ${source}` : "Aggregated", cls: "bg-primary/15 text-primary", icon: "🟡" },
    low_confidence: { label: "Low confidence", cls: "bg-destructive/15 text-destructive", icon: "🟠" },
    locked: { label: "Locked", cls: "bg-secondary text-foreground", icon: "🔒" },
  } as const;
  const m = map[badge];
  return (
    <span className={`mono inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${m.cls}`}>
      <span>{m.icon}</span>
      <span>{m.label}</span>
      {confidence != null ? <span className="opacity-70">· {confidence}</span> : null}
    </span>
  );
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

function Empty({ msg, withPipelineLink }: { msg: string; withPipelineLink?: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-card/40 p-8 text-center text-sm text-muted-foreground">
      <div>{msg}</div>
      {withPipelineLink ? (
        <div className="mt-2">
          See{" "}
          <Link to="/lineup-status" className="text-primary hover:underline">/lineup-status</Link>{" "}
          to see what's missing and push games through the pipeline.
        </div>
      ) : null}
    </div>
  );
}

function NotPersistedStat({ label }: { label: string }) {
  return (
    <div
      className="flex items-center justify-between rounded bg-secondary/20 px-2 py-1"
      title="Not available yet — field not persisted"
    >
      <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="mono text-[10px] italic text-muted-foreground">not persisted</span>
    </div>
  );
}
