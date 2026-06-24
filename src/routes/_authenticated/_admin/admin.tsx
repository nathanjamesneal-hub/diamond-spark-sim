import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  importSchedule, importLineups, importStartingPitchers,
  runDiamondEngine, lockProjections, importResults, runCalibration,
  createModelVersion, recomputePlayerDNA,
} from "@/lib/ingest.functions";


export const Route = createFileRoute("/_authenticated/_admin/admin")({
  head: () => ({ meta: [{ title: "Admin · Diamond" }] }),
  component: AdminPanel,
});

type RunState = { running: boolean; last?: { ok: boolean; msg: string; at: string } };

function AdminPanel() {
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [state, setState] = useState<Record<string, RunState>>({});
  const [newVersion, setNewVersion] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [activate, setActivate] = useState(true);
  const [dnaOnlyMissing, setDnaOnlyMissing] = useState(false);


  const sched = useServerFn(importSchedule);
  const lineups = useServerFn(importLineups);
  const sps = useServerFn(importStartingPitchers);
  const engine = useServerFn(runDiamondEngine);
  const lock = useServerFn(lockProjections);
  const results = useServerFn(importResults);
  const calib = useServerFn(runCalibration);
  const createVer = useServerFn(createModelVersion);
  const recomputeDna = useServerFn(recomputePlayerDNA);


  async function run(key: string, fn: () => Promise<any>) {
    setState((s) => ({ ...s, [key]: { running: true, last: s[key]?.last } }));
    try {
      const res = await fn();
      const msg = res?.ok
        ? `${res.details ?? `${res.count} rows`}`
        : `Error: ${res?.error ?? "unknown"}`;
      setState((s) => ({ ...s, [key]: { running: false, last: { ok: !!res?.ok, msg, at: new Date().toLocaleTimeString() } } }));
    } catch (e: any) {
      setState((s) => ({ ...s, [key]: { running: false, last: { ok: false, msg: e.message ?? String(e), at: new Date().toLocaleTimeString() } } }));
    }
  }

  const ops: Array<{ key: string; label: string; desc: string; go: () => Promise<any> }> = [
    { key: "schedule", label: "Import schedule", desc: "Upserts teams + games for the date.", go: () => sched({ data: { date } }) },
    { key: "lineups", label: "Import lineups", desc: "Pulls confirmed lineups + roster sync.", go: () => lineups({ data: { date } }) },
    { key: "sp", label: "Import starting pitchers", desc: "Probable + confirmed SP assignments.", go: () => sps({ data: { date } }) },
    { key: "dna", label: "Recompute Player DNA", desc: "Pulls MLB season stats and refreshes contact / power / speed / discipline / consistency. Run when DNA looks stale (all-50 defaults).", go: () => recomputeDna({ data: { onlyMissing: dnaOnlyMissing } }) },
    { key: "engine", label: "Run Diamond Engine", desc: "Generates a new projection row per hitter (append-only).", go: () => engine({ data: { date } }) },

    { key: "lock", label: "Lock projections", desc: "Stamps lineups with locked_at.", go: () => lock({ data: { date } }) },
    { key: "results", label: "Import results", desc: "Pulls box-score outcomes for calibration.", go: () => results({ data: { date } }) },
    { key: "calib", label: "Run calibration", desc: "Recomputes the calibration_summary table.", go: () => calib({ data: {} }) },
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <div className="mb-8">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">Admin · Operations</div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Diamond control room</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every operation is named, dated, and audited. Projections are append-only.
        </p>
      </div>

      <div className="mb-6 flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 p-4">
        <label className="mono text-[11px] uppercase tracking-widest text-muted-foreground">Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="mono rounded-md border border-border/60 bg-background px-2 py-1 text-sm" />
      </div>

      <div className="grid gap-3">
        {ops.map((op) => {
          const s = state[op.key];
          return (
            <div key={op.key} className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border/60 bg-card/40 p-4">
              <div className="min-w-0 flex-1">
                <div className="font-display font-semibold">{op.label}</div>
                <div className="text-xs text-muted-foreground">{op.desc}</div>
                {op.key === "dna" ? (
                  <label className="mono mt-2 inline-flex items-center gap-2 text-[11px] uppercase tracking-widest text-muted-foreground">
                    <input type="checkbox" checked={dnaOnlyMissing} onChange={(e) => setDnaOnlyMissing(e.target.checked)} />
                    Only players missing DNA
                  </label>
                ) : null}
                {s?.last ? (
                  <div className={`mono mt-1 text-[11px] ${s.last.ok ? "text-edge" : "text-destructive"}`}>
                    {s.last.at} · {s.last.msg}
                  </div>
                ) : null}
              </div>

              <button
                onClick={() => run(op.key, op.go)} disabled={s?.running}
                className="mono rounded-md bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-primary-foreground disabled:opacity-50"
              >
                {s?.running ? "Running…" : "Run"}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-10 rounded-lg border border-border/60 bg-card/40 p-5">
        <div className="mono text-[11px] uppercase tracking-widest text-edge">Model versions</div>
        <h2 className="font-display text-xl font-semibold">Create new model version</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_2fr_auto_auto]">
          <input placeholder="0.2.0" value={newVersion} onChange={(e) => setNewVersion(e.target.value)}
            className="mono rounded-md border border-border/60 bg-background px-2 py-1 text-sm" />
          <input placeholder="Notes (matchup grade revamp)" value={newNotes} onChange={(e) => setNewNotes(e.target.value)}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-sm" />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
            Activate
          </label>
          <button
            onClick={() => run("createVersion", () => createVer({ data: { version: newVersion, notes: newNotes, activate } }))}
            disabled={!newVersion}
            className="mono rounded-md bg-secondary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest disabled:opacity-50"
          >Create</button>
        </div>
        {state.createVersion?.last ? (
          <div className={`mono mt-2 text-[11px] ${state.createVersion.last.ok ? "text-edge" : "text-destructive"}`}>
            {state.createVersion.last.at} · {state.createVersion.last.msg}
          </div>
        ) : null}
      </div>
    </div>
  );
}
