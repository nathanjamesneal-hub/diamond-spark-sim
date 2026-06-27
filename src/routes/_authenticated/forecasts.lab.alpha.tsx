import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import {
  getProjectionLabAlphaCompare,
  type LabRow,
} from "@/lib/projection-lab.functions";
import { LayerLegend } from "@/components/projection-lab/layer-legend";
import { formatDateTimeInAppTz } from "@/lib/timezone";
import { supabase } from "@/integrations/supabase/client";

const searchSchema = z.object({
  date: z.string().optional(),
  preview: z.boolean().optional(),
  modelVersion: z.string().optional(),
});

function compareQuery(args: {
  date?: string;
  preview?: boolean;
  modelVersion?: string;
}) {
  return queryOptions({
    queryKey: ["projection-lab", "alpha-compare", args],
    queryFn: () =>
      getProjectionLabAlphaCompare({
        data: {
          date: args.date,
          modelVersion: args.modelVersion,
          includePreview: !!args.preview,
        },
      }),
    staleTime: 30_000,
  });
}

export const Route = createFileRoute("/_authenticated/forecasts/lab/alpha")({
  ssr: false,
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => ({
    date: search.date,
    preview: search.preview,
    modelVersion: search.modelVersion,
  }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(compareQuery(deps)),
  component: AlphaComparePage,
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-7xl px-4 py-6 text-sm text-destructive md:px-6">
      Couldn't load Alpha vs Diamond: {error.message}
    </div>
  ),
});

function fmtPct(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  return `${(n * 100).toFixed(0)}%`;
}
function fmtNum(n: number | null | undefined, d = 2) {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(d);
}

function AlphaComparePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(compareQuery(search));

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
    return () => { active = false; };
  }, []);

  type SortKey = "alpha" | "calibrated" | "mean" | "ds";
  const [sortKey, setSortKey] = useState<SortKey>("ds");

  const enriched = useMemo(() => {
    const rows = data.rows.map((r) => ({
      row: r,
      alpha: r.hit_probability,
      calibrated: r.calibrated_hit_probability,
      hitsMean: r.distributions.H?.mean ?? null,
      ds: r.diamond_score,
    }));
    // Diamond Rank within slate by DS desc
    const ranked = [...rows].sort((a, b) => (b.ds ?? -Infinity) - (a.ds ?? -Infinity));
    const rankByRunPlayer = new Map<string, number>();
    ranked.forEach((x, idx) => {
      rankByRunPlayer.set(`${x.row.forecast_run_id}::${x.row.player?.id ?? ""}`, idx + 1);
    });
    return rows.map((x) => ({
      ...x,
      rank: rankByRunPlayer.get(`${x.row.forecast_run_id}::${x.row.player?.id ?? ""}`) ?? null,
    }));
  }, [data.rows]);

  const sorted = useMemo(() => {
    const arr = [...enriched];
    arr.sort((a, b) => {
      const pick = (x: typeof a) => {
        switch (sortKey) {
          case "alpha": return x.alpha ?? -Infinity;
          case "calibrated": return x.calibrated ?? -Infinity;
          case "mean": return x.hitsMean ?? -Infinity;
          case "ds": return x.ds ?? -Infinity;
        }
      };
      return pick(b) - pick(a);
    });
    return arr;
  }, [enriched, sortKey]);

  function gradeHit(actual: number | null | undefined): "hit" | "miss" | null {
    if (actual == null) return null;
    if (actual <= 0) return "miss";
    return "hit";
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 md:px-6">
      <LayerLegend />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-card/50 p-3 text-sm">
        <label className="flex flex-col">
          <span className="mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Slate date</span>
          <input
            type="date"
            value={data.date}
            onChange={(e) =>
              navigate({
                search: (prev: Record<string, any>) => ({ ...prev, date: e.target.value || undefined }),
                replace: true,
              })
            }
            className="rounded border border-border/60 bg-background/60 px-2 py-1"
          />
        </label>
        <label className="flex flex-col">
          <span className="mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Model version</span>
          <select
            value={search.modelVersion ?? ""}
            onChange={(e) =>
              navigate({
                search: (prev: Record<string, any>) => ({ ...prev, modelVersion: e.target.value || undefined }),
                replace: true,
              })
            }
            className="rounded border border-border/60 bg-background/60 px-2 py-1"
          >
            <option value="">All present</option>
            {data.model_versions_present.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
        {isAdmin ? (
          <label className="ml-auto flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!search.preview}
              onChange={(e) =>
                navigate({
                  search: (prev: Record<string, any>) => ({ ...prev, preview: e.target.checked || undefined }),
                  replace: true,
                })
              }
            />
            <span className="mono text-[10px] uppercase tracking-[0.18em] text-amber-300">
              Include preview snapshots (admin)
            </span>
          </label>
        ) : null}
      </div>

      <div className="text-xs text-muted-foreground">
        Comparing Hit 1+ across {sorted.length} hitter snapshots for {data.date}.
        Alpha probability is the raw model belief; Calibrated probability is
        whatever was persisted alongside it. Diamond Score is a separate
        ranking layer and does <span className="font-semibold text-foreground">not</span> replace the
        Alpha probability.
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-card/30 p-8 text-center text-sm text-muted-foreground">
          <div className="font-display text-xl text-foreground">No hitter snapshots for {data.date}</div>
          <p className="mx-auto mt-2 max-w-xl">
            Official forecasts publish once 9 confirmed hitters and a confirmed
            starting pitcher exist per side. This view never regenerates
            projections — it only reads persisted snapshots.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/60 bg-card/40">
          <table className="w-full text-sm">
            <thead className="border-b border-border/60 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-2 py-2 text-left">Hitter</th>
                <th
                  onClick={() => setSortKey("alpha")}
                  className={`cursor-pointer px-2 py-2 text-right ${sortKey === "alpha" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  Alpha Hit 1+{sortKey === "alpha" ? " ↓" : ""}
                </th>
                <th
                  onClick={() => setSortKey("calibrated")}
                  className={`cursor-pointer px-2 py-2 text-right ${sortKey === "calibrated" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  Calibrated{sortKey === "calibrated" ? " ↓" : ""}
                </th>
                <th
                  onClick={() => setSortKey("mean")}
                  className={`cursor-pointer px-2 py-2 text-right ${sortKey === "mean" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  Hits μ{sortKey === "mean" ? " ↓" : ""}
                </th>
                <th className="px-2 py-2 text-right text-muted-foreground">PA μ</th>
                <th
                  onClick={() => setSortKey("ds")}
                  className={`cursor-pointer px-2 py-2 text-right ${sortKey === "ds" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  Diamond Score{sortKey === "ds" ? " ↓" : ""}
                </th>
                <th className="px-2 py-2 text-right">Rank</th>
                <th className="px-2 py-2 text-right">Class / Status</th>
                <th className="px-2 py-2 text-right">Hits actual</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(({ row, alpha, calibrated, hitsMean, ds, rank }, i) => {
                const actualHits = (row.actual as any)?.hits ?? null;
                const grade = gradeHit(actualHits);
                return (
                  <tr key={`${row.forecast_run_id}::${row.player?.id ?? i}`} className="border-b border-border/40">
                    <td className="px-2 py-2">
                      <div className="font-medium">{row.player?.full_name ?? "—"}</div>
                      <div className="mono text-[11px] text-muted-foreground">
                        {row.player_team_abbr ?? "—"} vs {row.opponent_abbr ?? "—"}
                        {row.batting_order != null ? ` · #${row.batting_order}` : ""}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right mono tabular-nums">{fmtPct(alpha)}</td>
                    <td className="px-2 py-2 text-right">
                      {calibrated == null ? (
                        <span className="mono text-[11px] text-muted-foreground">Raw · uncalibrated</span>
                      ) : (
                        <span className="mono tabular-nums">{fmtPct(calibrated)}</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right mono tabular-nums">{fmtNum(hitsMean)}</td>
                    <td className="px-2 py-2 text-right text-muted-foreground">not stored</td>
                    <td className="px-2 py-2 text-right mono tabular-nums">{fmtNum(ds, 1)}</td>
                    <td className="px-2 py-2 text-right mono tabular-nums">{rank ?? "—"}</td>
                    <td className="px-2 py-2 text-right">
                      <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                        {row.projection_class} · {row.run_status}
                      </div>
                      <div className="mono text-[10px] text-muted-foreground">
                        {row.model_version} · {row.forecast_timestamp ? formatDateTimeInAppTz(row.forecast_timestamp) : "—"}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right">
                      {grade === null ? (
                        <span className="mono text-[11px] text-muted-foreground">pending</span>
                      ) : grade === "hit" ? (
                        <span className="mono inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.18em] text-emerald-300">
                          {actualHits} hit{actualHits === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="mono inline-flex items-center gap-1 rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.18em] text-rose-300">
                          0 hits
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
