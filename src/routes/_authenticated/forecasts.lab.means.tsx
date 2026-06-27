import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import {
  getProjectionLabMeans,
  type LabPayload,
  type LabRow,
  type DistStat,
} from "@/lib/projection-lab.functions";
import { LayerLegend } from "@/components/projection-lab/layer-legend";
import { formatDateTimeInAppTz } from "@/lib/timezone";
import { supabase } from "@/integrations/supabase/client";

const searchSchema = z.object({
  date: z.string().optional(),
  role: z.enum(["hitter", "pitcher"]).optional(),
  preview: z.boolean().optional(),
  team: z.string().optional(),
  modelVersion: z.string().optional(),
});

function meansQuery(args: {
  date?: string;
  role?: "hitter" | "pitcher";
  preview?: boolean;
  team?: string;
  modelVersion?: string;
}) {
  return queryOptions({
    queryKey: ["projection-lab", "means", args],
    queryFn: () =>
      getProjectionLabMeans({
        data: {
          date: args.date,
          role: args.role,
          team: args.team,
          modelVersion: args.modelVersion,
          includePreview: !!args.preview,
        },
      }),
    staleTime: 30_000,
  });
}

export const Route = createFileRoute("/_authenticated/forecasts/lab/means")({
  ssr: false,
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => ({
    date: search.date,
    role: search.role,
    preview: search.preview,
    team: search.team,
    modelVersion: search.modelVersion,
  }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(meansQuery(deps)),
  component: MeansPage,
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-7xl px-4 py-6 text-sm text-destructive md:px-6">
      Couldn't load Simulation Means: {error.message}
    </div>
  ),
});

type SortKey =
  | "diamond_score"
  | "hits_mean"
  | "tb_mean"
  | "hr_mean"
  | "rbi_mean"
  | "r_mean"
  | "k_mean"
  | "outs_mean"
  | "bb_mean";

function metricValue(m: LabRow["sim_metrics"][keyof LabRow["sim_metrics"]]): number {
  return m?.mean ?? -Infinity;
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(digits);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

function MetricCell({ m }: { m: LabRow["sim_metrics"][keyof LabRow["sim_metrics"]] }) {
  const title = m.available ? m.sourcePath ?? undefined : m.unavailableReason ?? undefined;
  return <td className="px-2 py-2 text-right mono tabular-nums" title={title}>{fmt(m.mean)}</td>;
}

function StatusPill({ row }: { row: LabRow }) {
  const tone =
    row.run_status === "locked"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : "border-sky-500/40 bg-sky-500/10 text-sky-300";
  return (
    <span
      className={`mono inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.18em] ${tone}`}
    >
      {row.run_status}
    </span>
  );
}

function ClassPill({ row }: { row: LabRow }) {
  if (row.projection_class === "preview") {
    return (
      <span className="mono inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.18em] text-amber-300">
        preview
      </span>
    );
  }
  return null;
}

function GameStatePill({ row }: { row: LabRow }) {
  const map = {
    scheduled: "border-border/60 bg-card/60 text-muted-foreground",
    live: "border-rose-500/40 bg-rose-500/10 text-rose-300",
    final: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
  } as const;
  return (
    <span
      className={`mono inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.18em] ${map[row.game_display]}`}
    >
      {row.game_display}
    </span>
  );
}

function MeansPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(meansQuery(search));

  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let active = true;
    supabase.auth.getUser().then(async ({ data: u }) => {
      if (!u.user) return;
      const { data: ok } = await supabase.rpc("has_role", {
        _user_id: u.user.id,
        _role: "admin",
      });
      if (active) setIsAdmin(!!ok);
    });
    return () => {
      active = false;
    };
  }, []);

  const role = search.role ?? "hitter";
  const [sortKey, setSortKey] = useState<SortKey>(
    role === "pitcher" ? "k_mean" : "hits_mean",
  );
  const [advanced, setAdvanced] = useState(false);

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const r of data.rows) if (r.player_team_abbr) set.add(r.player_team_abbr);
    return Array.from(set).sort();
  }, [data.rows]);

  const sorted = useMemo(() => {
    const rows = [...data.rows];
    rows.sort((a, b) => {
      const va = pickSort(a, sortKey);
      const vb = pickSort(b, sortKey);
      return vb - va;
    });
    return rows;
  }, [data.rows, sortKey]);

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 md:px-6">
      <LayerLegend />
      <FiltersBar
        date={data.date}
        role={role}
        team={search.team}
        teams={teams}
        preview={!!search.preview}
        modelVersion={search.modelVersion}
        modelVersionsPresent={data.model_versions_present}
        isAdmin={isAdmin}
        advanced={advanced}
        onAdvanced={setAdvanced}
        onChange={(patch) =>
          navigate({
            search: (prev: Record<string, any>) => ({ ...prev, ...patch }),
            replace: true,
          })
        }
      />
      <SourceMetaBar data={data} />

      {data.rows.length === 0 ? (
        <EmptyState data={data} role={role} />
      ) : role === "pitcher" ? (
        <PitcherTable rows={sorted} advanced={advanced} sortKey={sortKey} setSortKey={setSortKey} />
      ) : (
        <HitterTable rows={sorted} advanced={advanced} sortKey={sortKey} setSortKey={setSortKey} />
      )}
    </div>
  );
}

function pickSort(r: LabRow, key: SortKey): number {
  switch (key) {
    case "diamond_score":
      return r.diamond_score ?? -Infinity;
    case "hits_mean":
      return metricValue(r.sim_metrics.H);
    case "tb_mean":
      return metricValue(r.sim_metrics.TB);
    case "hr_mean":
      return metricValue(r.sim_metrics.HR);
    case "rbi_mean":
      return metricValue(r.sim_metrics.RBI);
    case "r_mean":
      return metricValue(r.sim_metrics.R);
    case "k_mean":
      return metricValue(r.sim_metrics.K);
    case "bb_mean":
      return metricValue(r.sim_metrics.BB);
    case "outs_mean":
      return metricValue(r.sim_metrics.OUTS);
  }
}

function FiltersBar(props: {
  date: string;
  role: "hitter" | "pitcher";
  team?: string;
  teams: string[];
  preview: boolean;
  modelVersion?: string;
  modelVersionsPresent: string[];
  isAdmin: boolean;
  advanced: boolean;
  onAdvanced: (v: boolean) => void;
  onChange: (patch: Record<string, any>) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-card/50 p-3 text-sm">
      <label className="flex flex-col">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Slate date
        </span>
        <input
          type="date"
          value={props.date}
          onChange={(e) => props.onChange({ date: e.target.value || undefined })}
          className="rounded border border-border/60 bg-background/60 px-2 py-1"
        />
      </label>
      <label className="flex flex-col">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Role
        </span>
        <select
          value={props.role}
          onChange={(e) => props.onChange({ role: e.target.value })}
          className="rounded border border-border/60 bg-background/60 px-2 py-1"
        >
          <option value="hitter">Hitters</option>
          <option value="pitcher">Pitchers</option>
        </select>
      </label>
      <label className="flex flex-col">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Team
        </span>
        <select
          value={props.team ?? ""}
          onChange={(e) => props.onChange({ team: e.target.value || undefined })}
          className="rounded border border-border/60 bg-background/60 px-2 py-1"
        >
          <option value="">All teams</option>
          {props.teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Model version
        </span>
        <select
          value={props.modelVersion ?? ""}
          onChange={(e) => props.onChange({ modelVersion: e.target.value || undefined })}
          className="rounded border border-border/60 bg-background/60 px-2 py-1"
        >
          <option value="">All present</option>
          {props.modelVersionsPresent.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="ml-auto flex items-center gap-2">
        <input
          type="checkbox"
          checked={props.advanced}
          onChange={(e) => props.onAdvanced(e.target.checked)}
        />
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Advanced columns (seed, iterations, percentiles)
        </span>
      </label>
      {props.isAdmin ? (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={props.preview}
            onChange={(e) => props.onChange({ preview: e.target.checked || undefined })}
          />
          <span className="mono text-[10px] uppercase tracking-[0.18em] text-amber-300">
            Include preview snapshots (admin)
          </span>
        </label>
      ) : null}
    </div>
  );
}

function SourceMetaBar({ data }: { data: LabPayload }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span>
        <span className="mono uppercase tracking-[0.18em]">Slate</span> {data.date}
      </span>
      <span>·</span>
      <span>
        <span className="mono uppercase tracking-[0.18em]">Runs</span>{" "}
        {data.runs.length}
      </span>
      <span>·</span>
      <span>
        <span className="mono uppercase tracking-[0.18em]">Versions</span>{" "}
        {data.model_versions_present.join(", ") || "—"}
      </span>
      {data.reason === "no_official_anywhere" ? (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300">
          No official snapshots exist yet
        </span>
      ) : null}
      {data.missing_distribution_count > 0 ? (
        <span className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-rose-300">
          {data.missing_distribution_count} rows missing persisted distributions
        </span>
      ) : null}
    </div>
  );
}

function EmptyState({ data, role }: { data: LabPayload; role: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-card/30 p-8 text-center text-sm text-muted-foreground">
      <div className="font-display text-xl text-foreground">
        Awaiting confirmed lineups
      </div>
      <p className="mx-auto mt-2 max-w-xl">
        No official {role} snapshots are persisted for {data.date}. Official
        forecasts publish once 9 confirmed hitters and a confirmed starting
        pitcher exist per side. This view never regenerates projections from
        live data — it shows only what was saved.
      </p>
    </div>
  );
}

function ThSort({
  k,
  label,
  current,
  set,
  className = "",
}: {
  k: SortKey;
  label: string;
  current: SortKey;
  set: (k: SortKey) => void;
  className?: string;
}) {
  const active = current === k;
  return (
    <th
      onClick={() => set(k)}
      className={`cursor-pointer select-none px-2 py-2 text-right ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"} ${className}`}
    >
      {label}
      {active ? " ↓" : ""}
    </th>
  );
}

function PlayerCell({ row }: { row: LabRow }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2">
        <span className="font-medium">{row.player?.full_name ?? "—"}</span>
        <ClassPill row={row} />
      </div>
      <div className="mono text-[11px] text-muted-foreground">
        {row.player_team_abbr ?? "—"} vs {row.opponent_abbr ?? "—"}
        {row.role === "hitter" ? (
          row.batting_order != null ? (
            <>
              {" "}
              · #{row.batting_order}
              {row.batting_order_source === "lineups" ? " *" : ""}
            </>
          ) : (
            " · order n/a"
          )
        ) : null}
        {row.player?.position ? <> · {row.player.position}</> : null}
      </div>
    </div>
  );
}

function MetaCell({ row }: { row: LabRow }) {
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <div className="flex items-center gap-1">
        <StatusPill row={row} />
        <GameStatePill row={row} />
      </div>
      <div className="mono text-[10px] text-muted-foreground">
        {row.model_version}
        {row.version_number != null ? ` v${row.version_number}` : ""}
      </div>
      <div className="mono text-[10px] text-muted-foreground">
        {row.forecast_timestamp
          ? formatDateTimeInAppTz(row.forecast_timestamp)
          : "—"}
      </div>
    </div>
  );
}

function PercentilesCell({ d }: { d: DistStat }) {
  if (!d) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="mono text-[11px] text-muted-foreground">
      p50 {fmt(d.p50)} · p90 {fmt(d.p90)}
    </span>
  );
}

function HitterTable({
  rows,
  advanced,
  sortKey,
  setSortKey,
}: {
  rows: LabRow[];
  advanced: boolean;
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/60 bg-card/40">
      <table className="w-full text-sm">
        <thead className="border-b border-border/60 text-xs uppercase tracking-wider">
          <tr>
            <th className="px-2 py-2 text-left">Player</th>
            <ThSort k="diamond_score" label="DS" current={sortKey} set={setSortKey} />
            <ThSort k="hits_mean" label="Hits μ" current={sortKey} set={setSortKey} />
            <ThSort k="tb_mean" label="TB μ" current={sortKey} set={setSortKey} />
            <ThSort k="hr_mean" label="HR μ" current={sortKey} set={setSortKey} />
            <ThSort k="rbi_mean" label="RBI μ" current={sortKey} set={setSortKey} />
            <ThSort k="r_mean" label="R μ" current={sortKey} set={setSortKey} />
            {advanced ? (
              <>
                <ThSort k="bb_mean" label="BB μ" current={sortKey} set={setSortKey} />
                <th className="px-2 py-2 text-right text-muted-foreground">PA μ</th>
                <th className="px-2 py-2 text-right text-muted-foreground">SB μ</th>
                <th className="px-2 py-2 text-right text-muted-foreground">Hit p50/p90</th>
                <th className="px-2 py-2 text-right text-muted-foreground">Iters</th>
                <th className="px-2 py-2 text-right text-muted-foreground">Seed</th>
              </>
            ) : null}
            <th className="px-2 py-2 text-right">Snapshot</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.forecast_run_id}::${r.player?.id ?? i}`} className="border-b border-border/40">
              <td className="px-2 py-2"><PlayerCell row={r} /></td>
              <td className="px-2 py-2 text-right mono tabular-nums">{fmt(r.diamond_score, 1)}</td>
              <MetricCell m={r.sim_metrics.H} />
              <MetricCell m={r.sim_metrics.TB} />
              <MetricCell m={r.sim_metrics.HR} />
              <MetricCell m={r.sim_metrics.RBI} />
              <MetricCell m={r.sim_metrics.R} />
              {advanced ? (
                <>
                  <MetricCell m={r.sim_metrics.BB} />
                  <td className="px-2 py-2 text-right text-muted-foreground">not stored</td>
                  <td className="px-2 py-2 text-right text-muted-foreground">not stored</td>
                  <td className="px-2 py-2 text-right"><PercentilesCell d={r.distributions.H} /></td>
                  <td className="px-2 py-2 text-right mono tabular-nums">
                    {r.iterations_persisted ?? "—"}
                  </td>
                  <td className="px-2 py-2 text-right mono tabular-nums">{r.simulation_seed ?? "—"}</td>
                </>
              ) : null}
              <td className="px-2 py-2 text-right"><MetaCell row={r} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PitcherTable({
  rows,
  advanced,
  sortKey,
  setSortKey,
}: {
  rows: LabRow[];
  advanced: boolean;
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/60 bg-card/40">
      <table className="w-full text-sm">
        <thead className="border-b border-border/60 text-xs uppercase tracking-wider">
          <tr>
            <th className="px-2 py-2 text-left">Pitcher</th>
            <ThSort k="diamond_score" label="DS" current={sortKey} set={setSortKey} />
            <ThSort k="k_mean" label="K μ" current={sortKey} set={setSortKey} />
            <ThSort k="outs_mean" label="Outs μ" current={sortKey} set={setSortKey} />
            <ThSort k="bb_mean" label="BB μ" current={sortKey} set={setSortKey} />
            <th className="px-2 py-2 text-right">Win prob</th>
            <th className="px-2 py-2 text-right">QS prob</th>
            {advanced ? (
              <>
                <th className="px-2 py-2 text-right text-muted-foreground">K p50/p90</th>
                <th className="px-2 py-2 text-right text-muted-foreground">Outs p50/p90</th>
                <th className="px-2 py-2 text-right text-muted-foreground">Iters</th>
                <th className="px-2 py-2 text-right text-muted-foreground">Seed</th>
              </>
            ) : null}
            <th className="px-2 py-2 text-right">Snapshot</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.forecast_run_id}::${r.player?.id ?? i}`} className="border-b border-border/40">
              <td className="px-2 py-2"><PlayerCell row={r} /></td>
              <td className="px-2 py-2 text-right mono tabular-nums">{fmt(r.diamond_score, 1)}</td>
              <MetricCell m={r.sim_metrics.K} />
              <MetricCell m={r.sim_metrics.OUTS} />
              <MetricCell m={r.sim_metrics.BB} />
              <td className="px-2 py-2 text-right mono tabular-nums">{fmtPct(r.pitcher_win_probability)}</td>
              <td className="px-2 py-2 text-right mono tabular-nums">{fmtPct(r.quality_start_probability)}</td>
              {advanced ? (
                <>
                  <td className="px-2 py-2 text-right"><PercentilesCell d={r.distributions.K} /></td>
                  <td className="px-2 py-2 text-right"><PercentilesCell d={r.distributions.outs} /></td>
                  <td className="px-2 py-2 text-right mono tabular-nums">{r.iterations_persisted ?? "—"}</td>
                  <td className="px-2 py-2 text-right mono tabular-nums">{r.simulation_seed ?? "—"}</td>
                </>
              ) : null}
              <td className="px-2 py-2 text-right"><MetaCell row={r} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
