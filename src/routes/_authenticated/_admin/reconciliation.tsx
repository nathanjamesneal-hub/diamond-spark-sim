import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getSlateReconciliation,
  regradeGameSnapshot,
  type ReconciliationGame,
  type RegradePayload,
} from "@/lib/engine-beta/reconciliation.functions";
import { todayInAppTz } from "@/lib/timezone";

export const Route = createFileRoute("/_authenticated/_admin/reconciliation")({
  head: () => ({
    meta: [
      { title: "Slate Reconciliation — Diamond Admin" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ReconciliationPage,
});

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function StatusPill({ ok, label }: { ok: boolean | null; label: string }) {
  const cls = ok === true
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
    : ok === false
      ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
      : "bg-muted/30 text-muted-foreground border-border/60";
  return (
    <span className={`mono inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${cls}`}>
      {label}
    </span>
  );
}

function ReconciliationPage() {
  const [date, setDate] = useState<string>(() => todayInAppTz());
  const [regrade, setRegrade] = useState<RegradePayload | null>(null);
  const [regradeError, setRegradeError] = useState<string | null>(null);

  const getFn = useServerFn(getSlateReconciliation);
  const regradeFn = useServerFn(regradeGameSnapshot);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["reconciliation", date],
    queryFn: () => getFn({ data: { date } }),
  });

  const regradeMut = useMutation({
    mutationFn: (snapshotId: string) => regradeFn({ data: { snapshotId } }),
    onMutate: () => { setRegradeError(null); setRegrade(null); },
    onSuccess: (payload) => setRegrade(payload),
    onError: (e: any) => setRegradeError(e?.message ?? String(e)),
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-6">
      <div className="mb-6">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">Admin · Diagnostics</div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Slate Reconciliation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only diagnostic per game. Truthful pregame gate: a game is gradable only when an immutable
          per-game snapshot exists AND was created before first pitch AND contains snapshot rows.
          Regrade re-reads final actuals against a valid pregame snapshot — it never creates locks,
          never overwrites snapshots, and never touches public forecast tables.
        </p>
        <div className="mt-3 flex gap-2 text-[11px]">
          <Link to="/admin" className="mono rounded border border-border/60 px-2 py-1 uppercase tracking-widest text-muted-foreground hover:bg-card/40">← Admin</Link>
          <Link to="/engine-beta" className="mono rounded border border-border/60 px-2 py-1 uppercase tracking-widest text-muted-foreground hover:bg-card/40">Engine Beta</Link>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/40 p-4">
        <label className="mono text-[11px] uppercase tracking-widest text-muted-foreground">Slate date (CT)</label>
        <input
          type="date"
          value={date}
          onChange={(e) => { setDate(e.target.value); setRegrade(null); setRegradeError(null); }}
          className="mono rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
        />
        <button
          onClick={() => { qc.invalidateQueries({ queryKey: ["reconciliation", date] }); }}
          className="mono rounded border border-border/60 px-3 py-1 text-[11px] uppercase tracking-widest text-muted-foreground hover:bg-card/40"
        >
          Refresh
        </button>
        {q.data && (
          <div className="mono ml-auto text-[11px] uppercase tracking-widest text-muted-foreground">
            {q.data.gradeable}/{q.data.totalGames} gradable
          </div>
        )}
      </div>

      {q.isLoading && <div className="mono text-[11px] text-muted-foreground">Loading…</div>}
      {q.error && <div className="mono text-[11px] text-rose-400">Error: {(q.error as any)?.message ?? String(q.error)}</div>}

      {q.data && q.data.games.length === 0 && (
        <div className="mono text-[11px] text-muted-foreground">No games scheduled on {q.data.slateDate}.</div>
      )}

      {q.data && q.data.games.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border/60 bg-card/40">
          <table className="w-full text-[12px]">
            <thead className="mono bg-card/60 text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="p-2 text-left">Matchup</th>
                <th className="p-2 text-left">First pitch (CT)</th>
                <th className="p-2 text-left">Status</th>
                <th className="p-2 text-left">Lineup</th>
                <th className="p-2 text-left">Baseline</th>
                <th className="p-2 text-left">Shadow</th>
                <th className="p-2 text-left">Snapshot</th>
                <th className="p-2 text-left">Actuals</th>
                <th className="p-2 text-left">Gradable</th>
                <th className="p-2 text-left">Action</th>
              </tr>
            </thead>
            <tbody>
              {q.data.games.map((g) => (
                <GameRow key={g.gameId} g={g} onRegrade={(id) => regradeMut.mutate(id)} regrading={regradeMut.isPending} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {regradeError && (
        <div className="mono mt-4 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-[11px] text-rose-300">
          Regrade error: {regradeError}
        </div>
      )}

      {regrade && <RegradeResult payload={regrade} />}
    </div>
  );
}

function GameRow({ g, onRegrade, regrading }: {
  g: ReconciliationGame; onRegrade: (id: string) => void; regrading: boolean;
}) {
  return (
    <>
      <tr className="border-t border-border/40 align-top">
        <td className="p-2">
          <Link to="/game/$gamePk" params={{ gamePk: String(g.gamePk) }} className="text-primary hover:underline">
            {g.awayAbbr ?? "?"} @ {g.homeAbbr ?? "?"}
          </Link>
          <div className="mono text-[10px] text-muted-foreground">pk {g.gamePk}</div>
        </td>
        <td className="p-2 mono text-[11px]">{fmtTime(g.firstPitchAt)}</td>
        <td className="p-2 mono text-[11px]">
          <StatusPill ok={g.isFinal ? true : null} label={g.gameStatus ?? "—"} />
        </td>
        <td className="p-2 mono text-[11px]">
          {g.lineup ? (
            <>
              <div>{g.lineup.status} · {g.lineup.hittersSet}/{g.lineup.hittersExpected}</div>
              <div className="text-muted-foreground">conf {g.lineup.confidence ?? "—"}</div>
            </>
          ) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="p-2 mono text-[11px]">
          <StatusPill ok={g.baseline.exists ? (g.baseline.status === "locked" && g.baseline.lockedBeforeFirstPitch === true ? true : false) : null} label={g.baseline.status ?? "missing"} />
          <div className="mt-1 text-muted-foreground">{g.baseline.reason}</div>
          {g.baseline.lockedAt && (
            <div className="text-muted-foreground">locked {fmtTime(g.baseline.lockedAt)}</div>
          )}
        </td>
        <td className="p-2 mono text-[11px]">
          <StatusPill ok={g.shadow.exists ? true : null} label={g.shadow.exists ? "ran" : "none"} />
        </td>
        <td className="p-2 mono text-[11px]">
          {g.snapshot.exists ? (
            <>
              <StatusPill ok={g.snapshot.createdBeforeFirstPitch} label={g.snapshot.lockMode ?? "?"} />
              <div className="mt-1 text-muted-foreground">
                {g.snapshot.rowsCount} rows · created {fmtTime(g.snapshot.createdAt)}
              </div>
              {g.snapshot.lockReason && (
                <div className="text-rose-300">note: {g.snapshot.lockReason}</div>
              )}
            </>
          ) : <span className="text-muted-foreground">none</span>}
        </td>
        <td className="p-2 mono text-[11px]">{g.actualsCount}</td>
        <td className="p-2">
          <StatusPill ok={g.gradeable ? true : false} label={g.gradeable ? "yes" : "no"} />
          <div className="mono mt-1 text-[10px] text-muted-foreground">{g.gradeableLabel}</div>
        </td>
        <td className="p-2">
          {g.gradeable && g.snapshot.id ? (
            <button
              onClick={() => onRegrade(g.snapshot.id!)}
              disabled={regrading}
              className="mono rounded border border-primary/40 bg-primary/10 px-2 py-1 text-[10px] uppercase tracking-widest text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              {regrading ? "…" : "Regrade"}
            </button>
          ) : (
            <span className="mono text-[10px] text-muted-foreground">—</span>
          )}
        </td>
      </tr>
    </>
  );
}

function RegradeResult({ payload }: { payload: RegradePayload }) {
  return (
    <div className="mt-6 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="mono text-[11px] uppercase tracking-widest text-primary">
        Regrade · snapshot {payload.snapshotId.slice(0, 8)} · game pk {payload.gamePk ?? "—"} · {payload.slateDate}
      </div>
      <div className="mono mt-1 text-[10px] text-muted-foreground">
        Snapshot created {fmtTime(payload.createdAt)} · lock_mode {payload.lockMode} ·
        {" "}{payload.gradedRows}/{payload.totalRows} rows graded · regraded at {fmtTime(payload.regradedAt)}
      </div>

      <div className="mt-4 overflow-x-auto rounded border border-border/60 bg-card/40">
        <table className="w-full text-[12px]">
          <thead className="mono bg-card/60 text-[10px] uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="p-2 text-left">Category</th>
              <th className="p-2 text-right">Total</th>
              <th className="p-2 text-right">Graded</th>
              <th className="p-2 text-right">Hits</th>
              <th className="p-2 text-right">Hit rate</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(payload.byCategory).sort(([a],[b]) => a.localeCompare(b)).map(([k, v]) => (
              <tr key={k} className="border-t border-border/40">
                <td className="p-2 mono">{k}</td>
                <td className="p-2 mono text-right">{v.total}</td>
                <td className="p-2 mono text-right">{v.graded}</td>
                <td className="p-2 mono text-right">{v.hits}</td>
                <td className="p-2 mono text-right">{v.hitRate == null ? "—" : `${(v.hitRate * 100).toFixed(1)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-4">
        <summary className="mono cursor-pointer text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
          Per-row detail ({payload.rows.length})
        </summary>
        <div className="mt-2 overflow-x-auto rounded border border-border/60 bg-card/40">
          <table className="w-full text-[12px]">
            <thead className="mono bg-card/60 text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="p-2 text-left">Player</th>
                <th className="p-2 text-left">Cat</th>
                <th className="p-2 text-right">Score</th>
                <th className="p-2 text-right">Baseline</th>
                <th className="p-2 text-right">Shadow</th>
                <th className="p-2 text-right">Actual</th>
                <th className="p-2 text-left">Hit</th>
              </tr>
            </thead>
            <tbody>
              {payload.rows.map((r, i) => (
                <tr key={i} className="border-t border-border/40">
                  <td className="p-2">{r.player} <span className="text-muted-foreground">{r.team ?? ""}</span></td>
                  <td className="p-2 mono">{r.category}</td>
                  <td className="p-2 mono text-right">{r.score.toFixed(1)}</td>
                  <td className="p-2 mono text-right">{r.baselineMean == null ? "—" : r.baselineMean.toFixed(2)}</td>
                  <td className="p-2 mono text-right">{r.shadowMean == null ? "—" : r.shadowMean.toFixed(2)}</td>
                  <td className="p-2 mono text-right">{r.actual == null ? "—" : r.actual}</td>
                  <td className="p-2 mono">{r.hit == null ? "—" : r.hit ? "✓" : "×"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
