import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  getResearchLeaders,
  RESEARCH_CATEGORIES,
  type ResearchCategoryKey,
  type ResearchConfidenceTier,
  type ResearchDataStatus,
  type ResearchLeaderRow,
} from "@/lib/research-leaders.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type SortKey = "prob" | "mean" | "signal" | "confidence" | "first_pitch";

const leadersQuery = (slateDate: string, eligibleOnly: boolean, includeWaiting: boolean) =>
  queryOptions({
    queryKey: ["research-leaders", slateDate, eligibleOnly, includeWaiting],
    queryFn: () =>
      getResearchLeaders({
        data: { slateDate, eligibleOnly, includeWaiting },
      }),
  });

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export const Route = createFileRoute("/_authenticated/_admin/research-leaders")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Diamond Research Leaders — Admin" },
      {
        name: "description",
        content:
          "Model-favored player events ranked within their exact category. Experimental research only.",
      },
    ],
  }),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(leadersQuery(todayIso(), true, false)),
  component: ResearchLeadersPage,
});

function ResearchLeadersPage() {
  const [slateDate, setSlateDate] = useState(todayIso());
  const [eligibleOnly, setEligibleOnly] = useState(true);
  const [includeWaiting, setIncludeWaiting] = useState(false);
  const [activeCat, setActiveCat] = useState<ResearchCategoryKey>("HIT_1_PLUS");
  const [sortKey, setSortKey] = useState<SortKey>("prob");
  const [drawerRow, setDrawerRow] = useState<ResearchLeaderRow | null>(null);

  const { data } = useSuspenseQuery(leadersQuery(slateDate, eligibleOnly, includeWaiting));

  const populatedKeys = useMemo(
    () => new Set(data.categories.filter((c) => c.rows.length > 0).map((c) => c.category.key)),
    [data.categories],
  );

  const currentSection =
    data.categories.find((c) => c.category.key === activeCat) ??
    data.categories.find((c) => c.rows.length > 0) ??
    data.categories[0];

  const sortedRows = useMemo(() => {
    if (!currentSection) return [] as ResearchLeaderRow[];
    const rows = [...currentSection.rows];
    switch (sortKey) {
      case "mean":
        rows.sort((a, b) => b.projectedMean - a.projectedMean);
        break;
      case "signal":
        rows.sort((a, b) => b.researchSignal - a.researchSignal);
        break;
      case "confidence":
        rows.sort(
          (a, b) => tierWeight(b.confidenceTier) - tierWeight(a.confidenceTier),
        );
        break;
      case "first_pitch":
        rows.sort((a, b) => (a.firstPitchAt ?? "").localeCompare(b.firstPitchAt ?? ""));
        break;
      case "prob":
      default:
        rows.sort((a, b) => b.eventProbability - a.eventProbability);
    }
    return rows.map((r, i) => ({ ...r, rank: i + 1 }));
  }, [currentSection, sortKey]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="border-b border-zinc-800 bg-zinc-950/80 px-4 py-5 md:px-8">
        <div className="mx-auto max-w-[1400px] space-y-2">
          <div className="mono text-[10px] uppercase tracking-[0.3em] text-emerald-400/70">
            Private admin · experimental research
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
            DIAMOND RESEARCH LEADERS
          </h1>
          <p className="max-w-3xl text-sm text-zinc-400">
            Model-favored player events ranked within their exact category. Experimental
            research only. No sportsbook line, price, edge, pick, or recommendation is
            shown.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] space-y-5 px-4 py-6 md:px-8">
        {/* Controls */}
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mono block text-[10px] uppercase tracking-widest text-zinc-500">
              Slate date
            </label>
            <input
              type="date"
              value={slateDate}
              onChange={(e) => setSlateDate(e.target.value)}
              className="mt-1 rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
            />
          </div>

          <div>
            <label className="mono block text-[10px] uppercase tracking-widest text-zinc-500">
              Sort
            </label>
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
              <SelectTrigger className="mt-1 w-[200px] border-zinc-800 bg-zinc-900">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="prob">Event Probability</SelectItem>
                <SelectItem value="mean">Projected Mean</SelectItem>
                <SelectItem value="signal">Research Signal</SelectItem>
                <SelectItem value="confidence">Confidence</SelectItem>
                <SelectItem value="first_pitch">First Pitch</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-3 py-2">
            <Switch checked={eligibleOnly} onCheckedChange={setEligibleOnly} />
            <span className="text-xs text-zinc-300">Eligible / Locked-ready only</span>
          </div>
          <div className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-3 py-2">
            <Switch checked={includeWaiting} onCheckedChange={setIncludeWaiting} />
            <span className="text-xs text-zinc-300">Show waiting / incomplete games</span>
          </div>
        </div>

        {/* Category tabs */}
        <div className="-mx-4 overflow-x-auto px-4">
          <div className="flex min-w-max gap-2">
            {RESEARCH_CATEGORIES.map((cat) => {
              const populated = populatedKeys.has(cat.key);
              const active = currentSection?.category.key === cat.key;
              return (
                <button
                  key={cat.key}
                  onClick={() => populated && setActiveCat(cat.key)}
                  disabled={!populated}
                  className={`mono whitespace-nowrap rounded border px-3 py-2 text-[11px] uppercase tracking-widest transition ${
                    active
                      ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                      : populated
                        ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700"
                        : "cursor-not-allowed border-zinc-900 bg-zinc-950 text-zinc-600"
                  }`}
                >
                  {cat.label}
                  {!populated && <span className="ml-2 text-[9px] opacity-60">no data</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        {!currentSection || sortedRows.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-2">
            <div className="mono flex items-center justify-between text-[10px] uppercase tracking-widest text-zinc-500">
              <span>
                Top {sortedRows.length} · {currentSection.totalCandidates} candidate
                {currentSection.totalCandidates === 1 ? "" : "s"}
              </span>
              <span>Ranked within {currentSection.category.label} only</span>
            </div>
            <div className="divide-y divide-zinc-900 rounded border border-zinc-800 bg-zinc-950">
              {sortedRows.map((row) => (
                <ResearchRow
                  key={`${row.category}-${row.playerId}-${row.gameId}`}
                  row={row}
                  onOpen={() => setDrawerRow(row)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <DetailDrawer row={drawerRow} onClose={() => setDrawerRow(null)} />
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="border-zinc-800 bg-zinc-950">
      <CardContent className="p-8 text-center text-sm text-zinc-400">
        No lock-eligible research leaders yet. Waiting on confirmed lineups, starters,
        fresh forecast, and completed simulation outputs.
      </CardContent>
    </Card>
  );
}

function ResearchRow({
  row,
  onOpen,
}: {
  row: ResearchLeaderRow;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-start gap-4 px-4 py-3 text-left transition hover:bg-zinc-900/60"
    >
      <div className="mono w-8 shrink-0 pt-1 text-right text-lg font-bold tabular-nums text-emerald-400">
        {row.rank}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-display text-base font-semibold text-zinc-100">
            {row.playerName}
          </span>
          <span className="mono text-[11px] text-zinc-500">
            {row.teamAbbrev ?? "—"} vs {row.oppAbbrev ?? "—"}
          </span>
          {row.firstPitchAt && (
            <span className="mono text-[11px] text-zinc-500">
              {new Date(row.firstPitchAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          )}
          {row.battingOrder != null && row.battingOrder > 0 && (
            <span className="mono text-[11px] text-zinc-500">#{row.battingOrder}</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="text-zinc-400">{row.eventLabel}</span>
          <span className="mono font-semibold tabular-nums text-emerald-300">
            {(row.eventProbability * 100).toFixed(1)}%
          </span>
          <span className="mono text-[11px] text-zinc-500">
            proj {row.projectedMean.toFixed(2)}
          </span>
          {row.playerType === "bat" && row.projectedPA != null && (
            <span className="mono text-[11px] text-zinc-500">
              {row.projectedPA.toFixed(1)} PA
            </span>
          )}
          {row.playerType === "pit" && row.projectedBF != null && (
            <span className="mono text-[11px] text-zinc-500">
              {row.projectedBF.toFixed(1)} BF
            </span>
          )}
          <span className="mono text-[11px] text-zinc-500">
            signal {row.researchSignal}
          </span>
          <span
            className={`mono text-[11px] ${row.iterations == null ? "text-rose-400" : "text-zinc-400"}`}
          >
            {row.iterationsLabel}
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <ConfidenceBadge tier={row.confidenceTier} inputsStrong={row.inputsStrong} />
          {row.dataStatuses.map((s) => (
            <StatusChip key={s} status={s} />
          ))}
        </div>

        <div className="text-[11px] text-zinc-500">{row.whyItSurfaced}</div>
      </div>
    </button>
  );
}

function ConfidenceBadge({
  tier,
  inputsStrong,
}: {
  tier: ResearchConfidenceTier;
  inputsStrong: boolean;
}) {
  const cls: Record<ResearchConfidenceTier, string> = {
    HEAVY_CONFIDENCE: "border-emerald-500/60 bg-emerald-500/15 text-emerald-300",
    STRONG_RESEARCH: "border-sky-500/50 bg-sky-500/10 text-sky-300",
    WATCHLIST: "border-amber-500/50 bg-amber-500/10 text-amber-300",
    BETA_UNVALIDATED: "border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-300",
  };
  const label: Record<ResearchConfidenceTier, string> = {
    HEAVY_CONFIDENCE: "HEAVY CONFIDENCE",
    STRONG_RESEARCH: "STRONG RESEARCH",
    WATCHLIST: "WATCHLIST",
    BETA_UNVALIDATED: "BETA / UNVALIDATED",
  };
  return (
    <Badge
      variant="outline"
      className={`mono rounded border px-2 py-0 text-[9px] uppercase tracking-widest ${cls[tier]}`}
    >
      {label[tier]}
      {tier === "BETA_UNVALIDATED" && inputsStrong && (
        <span className="ml-1 opacity-80">· INPUTS STRONG</span>
      )}
    </Badge>
  );
}

function StatusChip({ status }: { status: ResearchDataStatus }) {
  const cls: Record<ResearchDataStatus, string> = {
    CONFIRMED_INPUTS: "border-emerald-800 bg-emerald-950/40 text-emerald-400",
    FORECAST_FRESH: "border-sky-800 bg-sky-950/40 text-sky-400",
    SIM_COMPLETE: "border-zinc-700 bg-zinc-900 text-zinc-400",
    WAITING_ON_LINEUP: "border-amber-800 bg-amber-950/40 text-amber-400",
    STARTER_UNCONFIRMED: "border-amber-800 bg-amber-950/40 text-amber-400",
    STALE: "border-rose-800 bg-rose-950/40 text-rose-400",
    NOT_LOCK_ELIGIBLE: "border-zinc-800 bg-zinc-950 text-zinc-500",
  };
  const label: Record<ResearchDataStatus, string> = {
    CONFIRMED_INPUTS: "CONFIRMED INPUTS",
    FORECAST_FRESH: "FORECAST FRESH",
    SIM_COMPLETE: "SIM COMPLETE",
    WAITING_ON_LINEUP: "WAITING ON LINEUP",
    STARTER_UNCONFIRMED: "STARTER UNCONFIRMED",
    STALE: "STALE",
    NOT_LOCK_ELIGIBLE: "NOT LOCK-ELIGIBLE",
  };
  return (
    <span
      className={`mono rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-widest ${cls[status]}`}
    >
      {label[status]}
    </span>
  );
}

function DetailDrawer({
  row,
  onClose,
}: {
  row: ResearchLeaderRow | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full max-w-md overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-md">
        {row && (
          <>
            <SheetHeader>
              <SheetTitle className="text-zinc-100">{row.playerName}</SheetTitle>
              <SheetDescription className="text-zinc-400">
                {row.teamAbbrev} vs {row.oppAbbrev} · {row.eventLabel}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-6 space-y-5 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Exact event prob" value={`${(row.eventProbability * 100).toFixed(2)}%`} />
                <Metric label="Projected mean" value={row.projectedMean.toFixed(3)} />
                {row.playerType === "bat" && row.projectedPA != null && (
                  <Metric label="Opportunity (PA)" value={row.projectedPA.toFixed(2)} />
                )}
                {row.playerType === "pit" && row.projectedBF != null && (
                  <Metric label="Opportunity (BF)" value={row.projectedBF.toFixed(2)} />
                )}
                <Metric label="Research signal" value={String(row.researchSignal)} />
                <Metric
                  label="Sim stderr"
                  value={row.stderr != null ? row.stderr.toFixed(3) : "—"}
                />
              </div>

              <div>
                <div className="mono text-[10px] uppercase tracking-widest text-zinc-500">
                  Confidence
                </div>
                <div className="mt-1">
                  <ConfidenceBadge tier={row.confidenceTier} inputsStrong={row.inputsStrong} />
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-zinc-400">
                  {row.confidenceReasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="mono text-[10px] uppercase tracking-widest text-zinc-500">
                  Data status
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {row.dataStatuses.map((s) => (
                    <StatusChip key={s} status={s} />
                  ))}
                </div>
              </div>

              <div className="space-y-1 text-xs text-zinc-400">
                <div>
                  <span className="text-zinc-500">Engine status: </span>
                  {row.engineStatus === "validated" ? (
                    <span className="text-emerald-400">validated</span>
                  ) : (
                    <span className="text-fuchsia-400">scaffold_unvalidated (Pipeline Test)</span>
                  )}
                </div>
                <div>
                  <span className="text-zinc-500">Sim job: </span>
                  <span className="mono">{row.simJobId.slice(0, 8)}</span> ·{" "}
                  {row.jobStatus} · {row.simTier}
                </div>
                <div>
                  <span className="text-zinc-500">Iterations: </span>
                  <span className={row.iterations == null ? "text-rose-400" : "text-zinc-200"}>
                    {row.iterationsLabel}
                  </span>
                  {row.iterationsSource && (
                    <span className="mono ml-1 text-[10px] text-zinc-600">
                      (source: {row.iterationsSource})
                    </span>
                  )}
                </div>
                <div>
                  <span className="text-zinc-500">Inputs hash: </span>
                  <span className="mono">{row.inputsHash.slice(0, 10)}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Output run status: </span>
                  {row.runStatus}
                </div>
                <div>
                  <span className="text-zinc-500">Sim completed: </span>
                  {new Date(row.completedAt).toLocaleString()}
                </div>
                <div>
                  <span className="text-zinc-500">Lock snapshot: </span>
                  {row.lockEligible ? (
                    <span className="text-emerald-400">eligible</span>
                  ) : (
                    <span className="text-zinc-500">not eligible</span>
                  )}
                </div>
              </div>

              <p className="border-t border-zinc-900 pt-3 text-[11px] text-zinc-500">
                Research view only. No odds, line shopping, bet recommendation, or pick
                language is provided.
              </p>

              <Button variant="outline" onClick={onClose} className="w-full">
                Close
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="mono text-[10px] uppercase tracking-widest text-zinc-500">{label}</div>
      <div className="mono text-base tabular-nums text-zinc-100">{value}</div>
    </div>
  );
}

function tierWeight(t: ResearchConfidenceTier): number {
  return t === "HEAVY_CONFIDENCE"
    ? 4
    : t === "STRONG_RESEARCH"
      ? 3
      : t === "BETA_UNVALIDATED"
        ? 2
        : 1;
}
