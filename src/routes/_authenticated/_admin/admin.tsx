import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  importSchedule, importLineups, importStartingPitchers,
  runDiamondEngine, lockProjections, importResults, runCalibration,
  createModelVersion, recomputePlayerDNA, runDailyPipeline,
  forceRunDiamondEngine, publishOfficialForecast,
  type DailyPipelineSummary, type ForceEngineSummary,
} from "@/lib/ingest.functions";

import { refreshLineupsAndProject, getCronStatus } from "@/lib/lineups/refresh.functions";
import { formatDateTimeInAppTz, todayInAppTz } from "@/lib/timezone";



export const Route = createFileRoute("/_authenticated/_admin/admin")({
  head: () => ({ meta: [{ title: "Admin · Diamond" }] }),
  component: AdminPanel,
});

type RunState = { running: boolean; last?: { ok: boolean; msg: string; at: string } };

function AdminPanel() {
  const [date, setDate] = useState<string>(() => todayInAppTz());
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineResult, setPipelineResult] = useState<DailyPipelineSummary | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const runPipeline = useServerFn(runDailyPipeline);
  const forceEngine = useServerFn(forceRunDiamondEngine);
  const [forceRunning, setForceRunning] = useState(false);
  const [forceResult, setForceResult] = useState<ForceEngineSummary | null>(null);
  const [forceError, setForceError] = useState<string | null>(null);

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
  const refresh = useServerFn(refreshLineupsAndProject);

  const qc = useQueryClient();

  async function run(key: string, fn: () => Promise<any>) {
    setState((s) => ({ ...s, [key]: { running: true, last: s[key]?.last } }));
    try {
      const res = await fn();
      const msg = res?.ok === false
        ? `Error: ${res?.error ?? "unknown"}`
        : (res?.details ?? formatRefresh(res) ?? `${res?.count ?? 0} rows`);
      setState((s) => ({ ...s, [key]: { running: false, last: { ok: res?.ok !== false, msg, at: new Date().toLocaleTimeString() } } }));
      qc.invalidateQueries({ queryKey: ["cron-status"] });
    } catch (e: any) {
      setState((s) => ({ ...s, [key]: { running: false, last: { ok: false, msg: e.message ?? String(e), at: new Date().toLocaleTimeString() } } }));
    }
  }

  const ops: Array<{ key: string; label: string; desc: string; go: () => Promise<any> }> = [
    { key: "schedule", label: "1 · Import schedule", desc: "Upserts teams + games for the date.", go: () => sched({ data: { date } }) },
    { key: "sp", label: "2 · Refresh probable pitchers", desc: "Probable + confirmed SP assignments.", go: () => sps({ data: { date } }) },
    { key: "refresh", label: "3 · Refresh Now (all providers)", desc: "Runs every enabled lineup provider, diffs, and re-projects only changed games. Same path as the 15-minute cron.", go: () => refresh({ data: { date } }) },
    { key: "lineups", label: "4 · Import confirmed MLB lineups (legacy)", desc: "Pulls MLB-only confirmed lineups + roster sync. Aggregator already does this; kept as a fallback.", go: () => lineups({ data: { date } }) },
    { key: "dna", label: "5 · Recompute Player DNA", desc: "Pulls MLB season stats and refreshes contact / power / speed / discipline / consistency.", go: () => recomputeDna({ data: { onlyMissing: dnaOnlyMissing } }) },
    { key: "engine", label: "6 · Run Diamond Engine (full slate)", desc: "Re-projects every game. Use only when needed; refresh handles incremental runs.", go: () => engine({ data: { date } }) },
    { key: "lock", label: "7 · Lock lineups", desc: "Stamps lineups with locked_at; cron stops refreshing locked games.", go: () => lock({ data: { date } }) },
    { key: "results", label: "8 · Import results", desc: "Pulls box-score outcomes for calibration.", go: () => results({ data: { date } }) },
    { key: "calib", label: "9 · Run calibration", desc: "Recomputes the calibration_summary table.", go: () => calib({ data: {} }) },
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <div className="mb-8">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">Admin · Operations</div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Diamond control room</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cron refreshes every 15 minutes during lineup hours. Diamond Engine runs only when lineup data actually changes.
        </p>
      </div>

      <CronStatusPanel />

      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/40 p-4">
        <label className="mono text-[11px] uppercase tracking-widest text-muted-foreground">Date (CT)</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="mono rounded-md border border-border/60 bg-background px-2 py-1 text-sm" />
        <button
          onClick={async () => {
            setPipelineRunning(true); setPipelineError(null); setPipelineResult(null);
            try {
              const r = await runPipeline({ data: { date } });
              setPipelineResult(r);
              qc.invalidateQueries({ queryKey: ["cron-status"] });
            } catch (e: any) {
              setPipelineError(e?.message ?? String(e));
            } finally { setPipelineRunning(false); }
          }}
          disabled={pipelineRunning}
          className="mono ml-auto rounded-md bg-primary px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-primary-foreground disabled:opacity-50"
        >
          {pipelineRunning ? "Updating slate…" : "Update Today's Slate"}
        </button>
      </div>

      {(pipelineResult || pipelineError) && (
        <div className="mb-6 rounded-lg border border-border/60 bg-card/40 p-4">
          <div className="mono mb-3 text-[11px] uppercase tracking-widest text-edge">Pipeline debug · {pipelineResult?.date ?? date}</div>
          {pipelineError ? (
            <div className="mono text-[12px] text-destructive">Pipeline crashed: {pipelineError}</div>
          ) : pipelineResult ? (
            <div className="grid gap-2 text-[12px]">
              <PipelineRow label="1 · Schedule" ok={!pipelineResult.schedule.error}
                msg={`${pipelineResult.schedule.games_upserted} games · ${pipelineResult.schedule.teams_upserted} teams`}
                error={pipelineResult.schedule.error} />
              <PipelineRow label="2 · Probable pitchers" ok={!pipelineResult.pitchers.error}
                msg={`${pipelineResult.pitchers.sp_upserted} SP assignments`}
                error={pipelineResult.pitchers.error} />
              <PipelineRow label="3 · Confirmed lineups" ok={!pipelineResult.lineups.error}
                msg={`${pipelineResult.lineups.lineup_rows} spots · ${pipelineResult.lineups.players_upserted} players · ${pipelineResult.lineups.games_with_confirmed} games confirmed`}
                error={pipelineResult.lineups.error} />
              <PipelineRow label="4 · Aggregator refresh" ok={!pipelineResult.refresh.error}
                msg={`${pipelineResult.refresh.providers.map(p => `${p.id}:${p.ok ? p.count : "err"}`).join(" · ") || "no providers"} · ${pipelineResult.refresh.changed_game_ids.length} changed games`}
                error={pipelineResult.refresh.error
                  ?? pipelineResult.refresh.providers.find(p => !p.ok)?.error} />
              <PipelineRow label="5 · Diamond Engine" ok={!pipelineResult.engine.error}
                msg={`${pipelineResult.engine.projections_inserted} projections across ${pipelineResult.engine.games_processed} games (v${pipelineResult.engine.version || "?"})${pipelineResult.engine.environment_failures ? ` · ${pipelineResult.engine.environment_failures} env failures` : ""}`}
                error={pipelineResult.engine.error} />
              <PipelineRow label="6 · Player cards" ok={pipelineResult.cards.games_pending === 0}
                msg={`${pipelineResult.cards.hitters} hitter · ${pipelineResult.cards.pitchers} pitcher cards · ${pipelineResult.cards.games_with_projections} games populated · ${pipelineResult.cards.games_pending} pending`} />
              <div className="mono mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                Total {pipelineResult.duration_ms} ms
              </div>
            </div>
          ) : null}
        </div>
      )}



      <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mono text-[11px] uppercase tracking-widest text-amber-400">Manual fallback</div>
            <div className="font-display text-lg font-semibold">Force Run Diamond Engine</div>
            <p className="text-xs text-muted-foreground">
              Runs predictions for every game on today's slate, even with partial lineups. Use when the
              automatic post-lineup trigger fails to populate player cards.
            </p>
          </div>
          <button
            onClick={async () => {
              setForceRunning(true); setForceError(null); setForceResult(null);
              try {
                const r = await forceEngine({ data: { date } });
                setForceResult(r);
                qc.invalidateQueries({ queryKey: ["diamond-scores"] });
                qc.invalidateQueries({ queryKey: ["lineup-status"] });
                qc.invalidateQueries({ queryKey: ["slate"] });
                qc.invalidateQueries({ queryKey: ["cron-status"] });
              } catch (e: any) {
                setForceError(e?.message ?? String(e));
              } finally { setForceRunning(false); }
            }}
            disabled={forceRunning}
            className="mono rounded-md bg-amber-500 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-black disabled:opacity-50"
          >
            {forceRunning ? "Running engine…" : "Force Run Engine"}
          </button>
        </div>

        {(forceResult || forceError) && (
          <div className="mt-4 rounded-md border border-border/60 bg-background/40 p-3">
            {forceError ? (
              <div className="mono text-[12px] text-destructive">Force run crashed: {forceError}</div>
            ) : forceResult ? (
              <div className="grid gap-2 text-[12px]">
                <div className="mono text-[11px] uppercase tracking-widest text-edge">
                  Force run · {forceResult.date} {forceResult.version ? `· v${forceResult.version}` : ""}
                </div>
                <div className="mono text-[11px] text-muted-foreground">
                  {forceResult.games_found} games found · {forceResult.games_processed} processed · {forceResult.games_skipped} skipped
                </div>
                <div className="mono text-[11px] text-muted-foreground">
                  {forceResult.hitter_predictions} hitter + {forceResult.pitcher_predictions} pitcher = {forceResult.hitter_predictions + forceResult.pitcher_predictions} predictions generated
                  {forceResult.environment_failures ? ` · ${forceResult.environment_failures} env failures` : ""}
                  {` · ${forceResult.duration_ms} ms`}
                </div>
                {forceResult.per_game.length > 0 && (
                  <details className="mt-1">
                    <summary className="mono cursor-pointer text-[11px] uppercase tracking-widest text-muted-foreground">
                      Per-game breakdown ({forceResult.per_game.length})
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="mono w-full text-[11px]">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1 text-left">Matchup</th>
                            <th className="px-2 py-1 text-left">Lineup</th>
                            <th className="px-2 py-1 text-left">SP</th>
                            <th className="px-2 py-1 text-left">Hit proj</th>
                            <th className="px-2 py-1 text-left">Pit proj</th>
                            <th className="px-2 py-1 text-left">Note</th>
                          </tr>
                        </thead>
                        <tbody>
                          {forceResult.per_game.map((g) => (
                            <tr key={g.game_id} className="border-t border-border/40">
                              <td className="px-2 py-1">{g.matchup}</td>
                              <td className="px-2 py-1">{g.lineup_players}</td>
                              <td className="px-2 py-1">{g.pitchers}</td>
                              <td className="px-2 py-1">{g.hitter_projections}</td>
                              <td className="px-2 py-1">{g.pitcher_projections}</td>
                              <td className="px-2 py-1 text-muted-foreground">{g.note ?? "ok"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </div>
            ) : null}
          </div>
        )}
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

      <PitchingBacklogPanel />
    </div>
  );
}

const PITCHING_BACKLOG_FIELDS = [
  "k_projection",
  "k_over_3_5_probability",
  "k_over_4_5_probability",
  "k_over_5_5_probability",
  "k_over_6_5_probability",
  "earned_runs_projection",
  "er_under_2_5_probability",
  "hits_allowed_projection",
  "walks_projection",
];

function PitchingBacklogPanel() {
  return (
    <div className="mt-10 rounded-lg border border-border/60 bg-card/40 p-5">
      <div className="mono text-[11px] uppercase tracking-widest text-edge">Pitching engine backlog</div>
      <h2 className="font-display text-xl font-semibold">Missing persisted pitcher fields</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        These fields are referenced by the pitcher card UI but are not yet written by the engine. Cards
        render "not persisted" until the engine produces and stores them.
      </p>
      <ul className="mt-3 grid gap-1 sm:grid-cols-2">
        {PITCHING_BACKLOG_FIELDS.map((f) => (
          <li key={f} className="mono text-[11px] text-muted-foreground">· {f}</li>
        ))}
      </ul>
    </div>
  );
}

function formatRefresh(res: any): string | null {
  if (!res || typeof res !== "object" || !("providers" in res)) return null;
  const providers = (res.providers ?? []) as { id: string; ok: boolean; count: number; error?: string }[];
  const provSummary = providers.map((p) => `${p.id}:${p.ok ? p.count : "✗"}`).join(" · ");
  const ran = res.engineRan ? `engine ran (${res.projectionsRegenerated} projections)` : "no engine run";
  return `${res.changedGameIds?.length ?? 0} games changed · ${ran} · ${provSummary} · ${res.durationMs}ms`;
}

function CronStatusPanel() {
  const status = useServerFn(getCronStatus);
  const { data } = useQuery({
    queryKey: ["cron-status"],
    queryFn: () => status(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const runs = data?.runs ?? [];
  const lastSuccess = runs.find((r: any) => !r.error);
  const lastEngine = runs.find((r: any) => r.engine_ran);
  const next = computeNextRefresh();

  return (
    <div className="mb-6 rounded-lg border border-border/60 bg-card/40 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="mono text-[11px] uppercase tracking-widest text-edge">Cron status</div>
        <div className="mono text-[11px] text-muted-foreground">next: {next}</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatusBlock label="Last refresh" value={lastSuccess ? formatDateTimeInAppTz(lastSuccess.started_at) : "—"} />
        <StatusBlock
          label="Last engine run"
          value={lastEngine ? `${formatDateTimeInAppTz(lastEngine.started_at)} · ${lastEngine.projections_regenerated} proj` : "—"}
        />
        <StatusBlock
          label="Last games changed"
          value={lastSuccess ? `${lastSuccess.games_changed} games · ${lastSuccess.players_changed} players` : "—"}
        />
        <StatusBlock
          label="Last duration"
          value={lastSuccess?.duration_ms != null ? `${lastSuccess.duration_ms} ms` : "—"}
        />
      </div>

      {lastSuccess?.providers ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {Object.entries(toProviderArray(lastSuccess.providers)).map(([id, p]: any) => (
            <span
              key={id}
              className={`mono rounded-full px-2 py-0.5 text-[10px] uppercase tracking-widest ${
                p.ok ? "bg-edge/15 text-edge" : "bg-destructive/15 text-destructive"
              }`}
              title={p.error ?? `${p.count} games · ${p.durationMs}ms`}
            >
              {p.id ?? id}: {p.ok ? p.count : "✗"}
            </span>
          ))}
        </div>
      ) : null}

      {runs.length > 0 ? (
        <details className="mt-4">
          <summary className="mono cursor-pointer text-[11px] uppercase tracking-widest text-muted-foreground">
            Last {runs.length} runs
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="mono w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left">Started</th>
                  <th className="px-2 py-1 text-left">ms</th>
                  <th className="px-2 py-1 text-left">Games</th>
                  <th className="px-2 py-1 text-left">Players</th>
                  <th className="px-2 py-1 text-left">Proj</th>
                  <th className="px-2 py-1 text-left">Engine</th>
                  <th className="px-2 py-1 text-left">Notes</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r: any) => (
                  <tr key={r.id} className={`border-t border-border/40 ${r.error ? "text-destructive" : ""}`}>
                    <td className="px-2 py-1">{formatDateTimeInAppTz(r.started_at)}</td>
                    <td className="px-2 py-1">{r.duration_ms ?? "—"}</td>
                    <td className="px-2 py-1">{r.games_changed}</td>
                    <td className="px-2 py-1">{r.players_changed}</td>
                    <td className="px-2 py-1">{r.projections_regenerated}</td>
                    <td className="px-2 py-1">{r.engine_ran ? "✓" : ""}</td>
                    <td className="px-2 py-1 text-muted-foreground">{r.error ?? r.notes ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function toProviderArray(providers: unknown): Record<string, any> {
  if (Array.isArray(providers)) {
    const m: Record<string, any> = {};
    for (const p of providers) if (p && p.id) m[p.id] = p;
    return m;
  }
  if (providers && typeof providers === "object") return providers as Record<string, any>;
  return {};
}

function StatusBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 p-3">
      <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
    </div>
  );
}

function computeNextRefresh(): string {
  const now = new Date();
  const next = new Date(now);
  const minutes = now.getUTCMinutes();
  const slot = Math.ceil((minutes + 0.0001) / 15) * 15;
  next.setUTCMinutes(slot, 0, 0);
  if (slot >= 60) {
    next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
  }
  return formatDateTimeInAppTz(next.toISOString());
}

function PipelineRow({ label, ok, msg, error }: { label: string; ok: boolean; msg: string; error?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border/40 bg-background/40 px-3 py-2">
      <div className="mono text-[11px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`mono text-[12px] ${ok ? "text-edge" : "text-destructive"}`}>
        {msg}{error ? ` · ${error}` : ""}
      </div>
    </div>
  );
}
