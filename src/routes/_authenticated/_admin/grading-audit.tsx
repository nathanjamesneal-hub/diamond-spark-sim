import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  getGradingAudit,
  getGameAuditDetail,
  retryAutoLock,
  retryScoreRefresh,
  type AuditGameRow,
  type GradingState,
} from "@/lib/grading-audit.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatDateTimeInAppTz, formatTimeInAppTz, todayInAppTz } from "@/lib/timezone";

const auditQuery = (date: string) =>
  queryOptions({
    queryKey: ["grading-audit", date],
    queryFn: () => getGradingAudit({ data: { date } }),
  });

export const Route = createFileRoute("/_authenticated/_admin/grading-audit")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Grading & Run Audit — Admin" },
      { name: "description", content: "Observability for pregame locks, outcome ingestion, and grading eligibility." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(auditQuery(todayInAppTz())),
  component: GradingAuditPage,
});

const STATE_STYLES: Record<GradingState, string> = {
  ELIGIBLE_TO_GRADE: "bg-emerald-600 hover:bg-emerald-600",
  GRADED: "bg-emerald-800 hover:bg-emerald-800",
  AWAITING_FINAL: "bg-sky-700 hover:bg-sky-700",
  MISSING_OUTCOMES: "bg-amber-600 hover:bg-amber-600",
  MISSED_PREGAME: "bg-rose-700 hover:bg-rose-700",
  LOCK_FAILED: "bg-rose-800 hover:bg-rose-800",
  NOT_READY_AT_LOCK: "bg-amber-800 hover:bg-amber-800",
  SCHEDULED: "bg-zinc-600 hover:bg-zinc-600",
};

function fmt(ts: string | null | undefined) {
  if (!ts) return "—";
  return formatDateTimeInAppTz(ts);
}
function fmtCt(ts: string | null | undefined) {
  if (!ts) return "—";
  return formatTimeInAppTz(ts);
}

function GradingAuditPage() {
  const [date, setDate] = useState<string>(todayInAppTz());
  const qc = useQueryClient();
  const { data } = useSuspenseQuery(auditQuery(date));
  const [selected, setSelected] = useState<AuditGameRow | null>(null);

  const refreshFn = useServerFn(retryScoreRefresh);
  const lockFn = useServerFn(retryAutoLock);

  const refreshMut = useMutation({
    mutationFn: () => refreshFn({ data: { date } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["grading-audit", date] }),
  });
  const lockMut = useMutation({
    mutationFn: () => lockFn({ data: { date } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["grading-audit", date] }),
  });

  const { summary, games } = data;

  const csvHref = useMemo(() => {
    const header = [
      "gamePk", "matchup", "firstPitchCT", "phase", "lockStatus", "lockReason",
      "snapshotId", "snapshotCreatedAt", "snapshotBeforeFirstPitch", "forecastVersion",
      "inputsHash", "engineStatus", "outcomeStatus", "gradingState", "gradeable", "blockingReasons",
    ].join(",");
    const rows = games.map((g) => [
      g.gamePk,
      JSON.stringify(g.matchup),
      JSON.stringify(fmtCt(g.firstPitchAt)),
      g.gamePhase,
      g.lockStatus,
      JSON.stringify(g.lockReason ?? ""),
      g.snapshotId ?? "",
      g.snapshotCreatedAt ?? "",
      String(g.snapshotBeforeFirstPitch ?? ""),
      g.forecastVersion ?? "",
      g.inputsHash ?? "",
      g.engineStatus ?? "",
      g.outcomeStatus,
      g.gradingState,
      String(g.gradeable),
      JSON.stringify(g.blockingReasons.join(" | ")),
    ].join(","));
    const csv = [header, ...rows].join("\n");
    return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  }, [games]);

  const incident = useMemo(() => {
    const lines: string[] = [];
    lines.push(`# Grading & Run Audit — ${date}`);
    lines.push("");
    lines.push(`Scheduled: ${summary.scheduled}`);
    lines.push(`Pregame snapshots locked: ${summary.pregameSnapshotsLocked}`);
    lines.push(`Missed pregame windows: ${summary.missedPregameWindows}`);
    lines.push(`Failed locks: ${summary.failedLocks}`);
    lines.push(`Awaiting final: ${summary.awaitingFinal}`);
    lines.push(`Missing outcomes: ${summary.missingOutcomes}`);
    lines.push(`Eligible to grade: ${summary.gradeable}`);
    lines.push(`Latest score refresh: ${fmt(summary.latestScoreRefreshAt)}`);
    lines.push(`Latest auto-lock: ${fmt(summary.latestAutoLockAt)}`);
    if (summary.latestErrorSummary) lines.push(`Latest error: ${summary.latestErrorSummary}`);
    lines.push("");
    lines.push("## Games");
    for (const g of games) {
      lines.push(`- ${g.matchup} (pk=${g.gamePk}) — ${g.gradingState}${g.lockReason ? ` — ${g.lockReason}` : ""}`);
      for (const b of g.blockingReasons) lines.push(`    • ${b}`);
    }
    const eligibleCoverage = summary.scheduled
      ? `${summary.gradeable}/${summary.scheduled} = ${((summary.gradeable / summary.scheduled) * 100).toFixed(1)}%`
      : "n/a";
    lines.push("");
    lines.push(`Slate coverage (eligible/scheduled): ${eligibleCoverage}`);
    return lines.join("\n");
  }, [date, games, summary]);

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Grading &amp; Run Audit</h1>
          <p className="text-sm text-muted-foreground max-w-2xl mt-1">
            Observability for pregame locks, outcome ingestion, and grading eligibility.
            A game is only <strong>ELIGIBLE_TO_GRADE</strong> when a pregame snapshot
            exists that was created <em>before first pitch</em> AND official outcomes
            have been ingested after the game is Final. Missed pregame games are
            permanently excluded from official pregame calibration.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-40"
          />
          <Button variant="outline" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
            {refreshMut.isPending ? "Refreshing…" : "Retry score refresh"}
          </Button>
          <Button variant="outline" onClick={() => lockMut.mutate()} disabled={lockMut.isPending}>
            {lockMut.isPending ? "Locking…" : "Retry auto-lock"}
          </Button>
          <a href={csvHref} download={`grading-audit-${date}.csv`}>
            <Button variant="outline">Download CSV</Button>
          </a>
          <Button
            variant="outline"
            onClick={() => navigator.clipboard.writeText(incident)}
          >
            Copy incident report
          </Button>
        </div>
      </div>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4 xl:grid-cols-6">
        <StatCard label="Scheduled" value={summary.scheduled} />
        <StatCard label="Pregame locked" value={summary.pregameSnapshotsLocked} tone="ok" />
        <StatCard label="Gradeable" value={summary.gradeable} tone="ok" />
        <StatCard label="Awaiting final" value={summary.awaitingFinal} tone="info" />
        <StatCard label="Missing outcomes" value={summary.missingOutcomes} tone="warn" />
        <StatCard label="Missed pregame" value={summary.missedPregameWindows} tone="err" />
        <StatCard label="Failed locks" value={summary.failedLocks} tone="err" />
        <StatCard label="Graded" value={summary.gradingCompleted} tone="ok" />
        <StatCard label="Last score refresh" value={fmt(summary.latestScoreRefreshAt)} small />
        <StatCard label="Last auto-lock" value={fmt(summary.latestAutoLockAt)} small />
        <StatCard label="Latest error" value={summary.latestErrorSummary ?? "—"} small tone={summary.latestErrorSummary ? "err" : undefined} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Per-game audit</CardTitle>
          {refreshMut.data && (
            <span className="text-xs text-muted-foreground">
              last refresh: scanned {refreshMut.data.scanned}, updates {refreshMut.data.statusUpdates}
            </span>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 pr-3">Game</th>
                <th className="py-2 pr-3">First pitch (CT)</th>
                <th className="py-2 pr-3">Phase</th>
                <th className="py-2 pr-3">Lock</th>
                <th className="py-2 pr-3">Reason</th>
                <th className="py-2 pr-3">Snapshot</th>
                <th className="py-2 pr-3">Outcomes</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {games.length === 0 && (
                <tr><td colSpan={9} className="py-6 text-center text-muted-foreground">No games scheduled.</td></tr>
              )}
              {games.map((g) => (
                <tr key={g.gameId} className="border-t border-border/40 align-top">
                  <td className="py-2 pr-3 font-mono">
                    <div>{g.matchup}</div>
                    <div className="text-xs text-muted-foreground">pk {g.gamePk}</div>
                  </td>
                  <td className="py-2 pr-3">{fmtCt(g.firstPitchAt)}</td>
                  <td className="py-2 pr-3">{g.gamePhase}</td>
                  <td className="py-2 pr-3">
                    <Badge variant={g.lockStatus === "auto_locked" || g.lockStatus === "manual_locked" ? "default" : "destructive"}>
                      {g.lockStatus}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 max-w-[200px]">
                    <span className="text-xs">{g.lockReason ?? "—"}</span>
                  </td>
                  <td className="py-2 pr-3">
                    {g.snapshotId ? (
                      <div>
                        <div className="font-mono text-xs">{g.snapshotId.slice(0, 8)}</div>
                        <div className="text-xs text-muted-foreground">{fmt(g.snapshotCreatedAt)}</div>
                        {g.snapshotBeforeFirstPitch === false && (
                          <div className="text-xs text-rose-500">after first pitch</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="text-xs">{g.outcomeStatus}</div>
                    {g.outcomeIngestedAt && (
                      <div className="text-xs text-muted-foreground">{fmt(g.outcomeIngestedAt)}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge className={STATE_STYLES[g.gradingState]}>{g.gradingState}</Badge>
                    {g.gradingState === "MISSED_PREGAME" && (
                      <div className="text-[10px] mt-1 text-rose-400 uppercase tracking-wide">
                        NOT VALID FOR PREGAME PERFORMANCE
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <Button size="sm" variant="outline" onClick={() => setSelected(g)}>
                      Inspect
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <DetailDrawer date={date} row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function StatCard({
  label, value, tone, small,
}: {
  label: string;
  value: string | number;
  tone?: "ok" | "warn" | "err" | "info";
  small?: boolean;
}) {
  const toneClass =
    tone === "ok" ? "text-emerald-500"
    : tone === "warn" ? "text-amber-500"
    : tone === "err" ? "text-rose-500"
    : tone === "info" ? "text-sky-500"
    : "text-foreground";
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`${small ? "text-sm" : "text-2xl"} font-semibold ${toneClass} truncate`} title={String(value)}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function DetailDrawer({
  date, row, onClose,
}: {
  date: string;
  row: AuditGameRow | null;
  onClose: () => void;
}) {
  const detailFn = useServerFn(getGameAuditDetail);
  const query = useMemo(
    () =>
      row
        ? {
            queryKey: ["grading-audit-detail", row.gameId, date],
            queryFn: () => detailFn({ data: { gameId: row.gameId, date } }),
            enabled: !!row,
          }
        : null,
    [row, date, detailFn],
  );
  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[520px] sm:max-w-[560px] overflow-y-auto">
        {row && (
          <div className="space-y-4">
            <SheetHeader>
              <SheetTitle>{row.matchup} — {row.gradingState}</SheetTitle>
            </SheetHeader>
            <div className="text-xs space-y-1">
              <div><span className="text-muted-foreground">First pitch:</span> {fmt(row.firstPitchAt)}</div>
              <div><span className="text-muted-foreground">Game status:</span> {row.gameStatus ?? "—"}</div>
              <div><span className="text-muted-foreground">Lock:</span> {row.lockStatus} {row.lockReason ? `— ${row.lockReason}` : ""}</div>
              <div><span className="text-muted-foreground">Snapshot ID:</span> <span className="font-mono">{row.snapshotId ?? "—"}</span></div>
              <div><span className="text-muted-foreground">Snapshot at:</span> {fmt(row.snapshotCreatedAt)}</div>
              <div><span className="text-muted-foreground">Forecast version:</span> {row.forecastVersion ?? "—"}</div>
              <div><span className="text-muted-foreground">Inputs hash:</span> <span className="font-mono">{row.inputsHash ?? "—"}</span></div>
              <div><span className="text-muted-foreground">Engine status:</span> {row.engineStatus ?? "—"}</div>
            </div>
            {row.blockingReasons.length > 0 && (
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">Blocking reasons</div>
                <ul className="text-xs list-disc pl-4 space-y-1">
                  {row.blockingReasons.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>
            )}
            {query && <DetailBody query={query} />}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DetailBody({ query }: { query: any }) {
  const { data } = useSuspenseQuery(queryOptions(query));
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs uppercase text-muted-foreground mb-1">Readiness evidence</div>
        <pre className="text-[10px] bg-muted rounded p-2 overflow-x-auto max-h-64">
          {JSON.stringify(data.freshness ?? {}, null, 2)}
        </pre>
      </div>
      <div className="text-xs">
        <div><span className="text-muted-foreground">Snapshot inputs hash:</span> <span className="font-mono">{data.snapshotInputsHash ?? "—"}</span></div>
        <div><span className="text-muted-foreground">Current inputs hash:</span> <span className="font-mono">{data.currentInputsHash ?? "—"}</span></div>
        <div>
          <span className="text-muted-foreground">Match:</span>{" "}
          {data.inputsHashMatch == null ? "—" : data.inputsHashMatch ? "yes" : <span className="text-amber-500">no (inputs drifted)</span>}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase text-muted-foreground mb-1">Lock logs</div>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {data.lockLogs.length === 0 && <div className="text-xs text-muted-foreground">No lock log entries.</div>}
          {data.lockLogs.map((l: any, i: number) => (
            <div key={i} className="text-[11px] font-mono border-l-2 border-border pl-2">
              <span className="text-muted-foreground">{fmt(l.started_at)}</span> · {l.stage ?? "—"} · {l.status}
              {l.error && <div className="text-rose-500">{l.error}</div>}
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase text-muted-foreground mb-1">Outcome (score refresh) logs</div>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {data.outcomeLogs.length === 0 && <div className="text-xs text-muted-foreground">No outcome log entries.</div>}
          {data.outcomeLogs.slice(0, 20).map((l: any, i: number) => (
            <div key={i} className="text-[11px] font-mono border-l-2 border-border pl-2">
              <span className="text-muted-foreground">{fmt(l.started_at)}</span> · {l.status}
              {l.error && <div className="text-rose-500">{l.error}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
