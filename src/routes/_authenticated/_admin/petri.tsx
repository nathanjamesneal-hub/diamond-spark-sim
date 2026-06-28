import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  runPetriShadowForUnstarted,
  getPetriRunsForDate,
  getPetriRunDetail,
  getPetriLiveTracker,
  type PetriRunSummary,
  type PetriRunDetail,
  type PetriLiveTrackerPayload,
} from "@/lib/petri/run.functions";
import { todayInAppTz, formatDateTimeInAppTz } from "@/lib/timezone";


export const Route = createFileRoute("/_authenticated/_admin/petri")({
  head: () => ({ meta: [{ title: "Petri v0.2 Shadow Lab · Diamond" }] }),
  component: PetriShadowLab,
});

const SHADOW_LABEL = "Petri v0.2 Shadow — Not Public / Not Calibrated";

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}
function f2(x: number) {
  return Number(x ?? 0).toFixed(2);
}

function PetriShadowLab() {
  const [date, setDate] = useState<string>(() => todayInAppTz());
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<PetriRunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const runShadow = useServerFn(runPetriShadowForUnstarted);
  const listRuns = useServerFn(getPetriRunsForDate);
  const detailFn = useServerFn(getPetriRunDetail);
  const trackerFn = useServerFn(getPetriLiveTracker);
  const qc = useQueryClient();

  const runsQuery = useQuery({
    queryKey: ["petri-runs", date],
    queryFn: () => listRuns({ data: { date } }),
  });

  const trackerQuery = useQuery({
    queryKey: ["petri-tracker", date],
    queryFn: () => trackerFn({ data: { date } }),
    refetchInterval: 45_000,
  });

  const detailQuery = useQuery({
    queryKey: ["petri-detail", openRunId],
    queryFn: () => detailFn({ data: { runId: openRunId! } }),
    enabled: !!openRunId,
  });


  async function onRun() {
    setRunning(true);
    setError(null);
    setSummary(null);
    try {
      const res = await runShadow({ data: { date } });
      setSummary(res);
      qc.invalidateQueries({ queryKey: ["petri-runs", date] });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-col gap-2 border-b border-zinc-800 pb-4">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl tracking-wide">Petri v0.2 Shadow Lab</h1>
          <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
            Admin-only · Isolated from Alpha 0.3
          </span>
        </div>
        <p className="text-sm text-zinc-400">
          {SHADOW_LABEL}. Petri runs only against games that have not started. Results never appear
          on public Diamond surfaces (Forecast Board, Consensus, Top Props, Results, grading).
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs uppercase tracking-wide text-zinc-400">
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <button
          type="button"
          disabled={running}
          onClick={onRun}
          className="rounded bg-amber-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
        >
          {running ? "Running…" : "Run Petri Shadow — Unstarted Games"}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>

      {summary && (
        <section className="rounded border border-zinc-800 bg-zinc-950/50 p-4">
          <h2 className="mb-2 font-display text-lg">Run Summary · {summary.date}</h2>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Stat label="Eligible" value={summary.eligibleGames} />
            <Stat label="Generated" value={summary.generated} />
            <Stat label="Abstained" value={summary.abstained.length} />
            <Stat label="Skipped" value={summary.skipped.length} />
            <Stat label="Locked at FP" value={summary.locked} />
            <Stat label="Hitter snapshots" value={summary.hitterSnapshots} />
            <Stat label="Pitcher snapshots" value={summary.pitcherSnapshots} />
            <Stat label="Duration" value={`${summary.durationMs} ms`} />
          </div>
          {(summary.abstained.length > 0 || summary.skipped.length > 0) && (
            <div className="mt-3 space-y-1 text-xs">
              {summary.abstained.map((a) => (
                <div key={`ab-${a.mlb_game_id}`} className="text-amber-400">
                  abstained · {a.matchup} · {a.reason}
                </div>
              ))}
              {summary.skipped.map((s) => (
                <div key={`sk-${s.mlb_game_id}`} className="text-zinc-400">
                  skipped · {s.matchup} · {s.reason}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <PetriLiveTrackerSection data={trackerQuery.data ?? null} loading={trackerQuery.isLoading} />

      <section>

        <h2 className="mb-2 font-display text-lg">Petri Runs · {date}</h2>
        {runsQuery.isLoading && <div className="text-sm text-zinc-400">Loading…</div>}
        {runsQuery.data && runsQuery.data.runs.length === 0 && (
          <div className="text-sm text-zinc-400">No Petri runs persisted for this date.</div>
        )}
        {runsQuery.data && runsQuery.data.runs.length > 0 && (
          <div className="overflow-x-auto rounded border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-xs uppercase tracking-wide text-zinc-400">
                <tr>
                  <th className="px-3 py-2 text-left">Matchup</th>
                  <th className="px-3 py-2 text-left">Class</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-right">Seed</th>
                  <th className="px-3 py-2 text-right">Iters</th>
                  <th className="px-3 py-2 text-right">Completeness</th>
                  <th className="px-3 py-2 text-right">Fallbacks</th>
                  <th className="px-3 py-2 text-left">Hash</th>
                  <th className="px-3 py-2 text-left">Created</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {runsQuery.data.runs.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-800">
                    <td className="px-3 py-2 font-medium">{r.matchup}</td>
                    <td className="px-3 py-2">
                      <ClassPill cls={r.projection_class} />
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.seed}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.iterations.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(r.data_completeness)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.fallback_count}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-400">{r.input_hash.slice(0, 10)}…</td>
                    <td className="px-3 py-2 text-xs text-zinc-400">{formatDateTimeInAppTz(r.created_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                        onClick={() => setOpenRunId(r.id)}
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openRunId && (
        <RunDrawer
          detail={detailQuery.data ?? null}
          loading={detailQuery.isLoading}
          onClose={() => setOpenRunId(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-display text-lg tabular-nums">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "preview"
      ? "bg-blue-500/15 text-blue-300"
      : status === "locked"
        ? "bg-zinc-700 text-zinc-200"
        : status === "abstained"
          ? "bg-amber-500/15 text-amber-300"
          : status === "superseded_duplicate"
            ? "bg-fuchsia-500/15 text-fuchsia-300"
            : status === "superseded"
              ? "bg-zinc-800 text-zinc-400"
              : "bg-red-500/15 text-red-300";
  return <span className={`rounded px-2 py-0.5 text-xs ${cls}`}>{status}</span>;
}

function ClassPill({ cls }: { cls: string }) {
  const tone =
    cls === "official"
      ? "bg-emerald-500/15 text-emerald-300"
      : "bg-indigo-500/15 text-indigo-300";
  return <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}>{cls}</span>;
}

function RunDrawer({
  detail,
  loading,
  onClose,
}: {
  detail: PetriRunDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="h-full w-full max-w-4xl overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-amber-400">{SHADOW_LABEL}</div>
            <h3 className="font-display text-xl">{detail?.run.matchup ?? "…"}</h3>
          </div>
          <button
            type="button"
            className="rounded border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-800"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {loading && <div className="text-sm text-zinc-400">Loading…</div>}
        {detail && (
          <div className="space-y-6">
            <section className="rounded border border-zinc-800 bg-zinc-900/40 p-3 text-xs">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <KV label="Status" value={detail.run.status} />
                <KV label="Seed" value={String(detail.run.seed)} />
                <KV label="Iterations" value={detail.run.iterations.toLocaleString()} />
                <KV label="Input Hash" value={detail.run.input_hash} mono />
                <KV label="Created" value={formatDateTimeInAppTz(detail.run.created_at)} />
                <KV label="Locked" value={detail.run.locked_at ? formatDateTimeInAppTz(detail.run.locked_at) : "—"} />
                <KV
                  label="Data Completeness"
                  value={pct(detail.run.data_completeness?.score ?? 0)}
                />
              </div>
              {detail.run.abstention_reasons && detail.run.abstention_reasons.length > 0 && (
                <div className="mt-2">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500">Abstention reasons</div>
                  <ul className="ml-4 list-disc text-amber-300">
                    {detail.run.abstention_reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
              {detail.run.fallbacks && detail.run.fallbacks.length > 0 && (
                <div className="mt-2">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500">Fallbacks</div>
                  <ul className="ml-4 list-disc text-zinc-300">
                    {detail.run.fallbacks.map((f, i) => (
                      <li key={i}>
                        <span className="font-mono">{f.path}</span> ← {f.source} ({f.reason}, {f.confidence_impact})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-2">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Source map</div>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">
                  {JSON.stringify(detail.run.input_source_map, null, 2)}
                </pre>
              </div>
            </section>

            <section>
              <h4 className="mb-2 font-display text-base">Hitters</h4>
              <div className="overflow-x-auto rounded border border-zinc-800">
                <table className="w-full text-xs">
                  <thead className="bg-zinc-900 text-[10px] uppercase tracking-wide text-zinc-400">
                    <tr>
                      <th className="px-2 py-1 text-left">#</th>
                      <th className="px-2 py-1 text-left">Player</th>
                      <th className="px-2 py-1 text-right">PA</th>
                      <th className="px-2 py-1 text-right">H</th>
                      <th className="px-2 py-1 text-right">Hit 1+</th>
                      <th className="px-2 py-1 text-right">TB</th>
                      <th className="px-2 py-1 text-right">TB 2+</th>
                      <th className="px-2 py-1 text-right">HR</th>
                      <th className="px-2 py-1 text-right">HR 1+</th>
                      <th className="px-2 py-1 text-right">K</th>
                      <th className="px-2 py-1 text-right">DC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.hitters.map((h) => (
                      <tr key={h.mlb_player_id} className="border-t border-zinc-800">
                        <td className="px-2 py-1 tabular-nums">{h.lineup_slot}</td>
                        <td className="px-2 py-1">{h.player_name}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(h.pa_mean)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(h.h_mean)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{pct(h.hit_1plus)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(h.tb_mean)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{pct(h.tb_2plus)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(h.hr_mean)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{pct(h.hr_1plus)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(h.hitter_k_mean)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{pct(h.data_completeness)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h4 className="mb-2 font-display text-base">Pitchers</h4>
              <div className="overflow-x-auto rounded border border-zinc-800">
                <table className="w-full text-xs">
                  <thead className="bg-zinc-900 text-[10px] uppercase tracking-wide text-zinc-400">
                    <tr>
                      <th className="px-2 py-1 text-left">Pitcher</th>
                      <th className="px-2 py-1 text-right">K mean</th>
                      <th className="px-2 py-1 text-right">K P10</th>
                      <th className="px-2 py-1 text-right">K P90</th>
                      <th className="px-2 py-1 text-right">Outs mean</th>
                      <th className="px-2 py-1 text-right">Outs P10</th>
                      <th className="px-2 py-1 text-right">Outs P90</th>
                      <th className="px-2 py-1 text-right">BF mean</th>
                      <th className="px-2 py-1 text-right">DC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.pitchers.map((p) => (
                      <tr key={p.mlb_player_id} className="border-t border-zinc-800">
                        <td className="px-2 py-1">{p.player_name}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(p.pk_mean)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(p.pk_p10)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(p.pk_p90)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(p.outs_mean)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(p.outs_p10)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(p.outs_p90)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{f2(p.bf_mean)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{pct(p.data_completeness)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={mono ? "font-mono text-xs break-all text-zinc-200" : "text-sm text-zinc-200"}>{value}</div>
    </div>
  );
}

function PetriLiveTrackerSection({
  data,
  loading,
}: {
  data: PetriLiveTrackerPayload | null;
  loading: boolean;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-display text-lg">Petri v0.2 Shadow — Live Tracker</h2>
        <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
          Raw · Not Yet Calibrated · Not a Public Recommendation
        </span>
        {data && (
          <span className="text-xs text-zinc-500">
            {data.games.length} locked game{data.games.length === 1 ? "" : "s"} · refreshed{" "}
            {formatDateTimeInAppTz(data.fetchedAt)}
          </span>
        )}
      </div>
      {loading && <div className="text-sm text-zinc-400">Loading tracker…</div>}
      {data && data.games.length === 0 && (
        <div className="text-sm text-zinc-400">
          No locked Petri runs for this date yet. Locking happens at first pitch.
        </div>
      )}
      {data?.games.map((g) => (
        <div key={g.run_id} className="rounded border border-zinc-800 bg-zinc-950/40">
          <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-3 py-2">
            <div className="font-display text-base">{g.matchup}</div>
            <GameStatePill state={g.game_state} />
            {g.locked_at && (
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                locked {formatDateTimeInAppTz(g.locked_at)}
              </span>
            )}
          </div>
          {g.hitters.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-zinc-900/60 text-[10px] uppercase tracking-wide text-zinc-400">
                  <tr>
                    <th className="px-2 py-1 text-left">#</th>
                    <th className="px-2 py-1 text-left">Hitter</th>
                    <th className="px-2 py-1 text-right">H μ</th>
                    <th className="px-2 py-1 text-right">Hit 1+</th>
                    <th className="px-2 py-1 text-right">TB μ</th>
                    <th className="px-2 py-1 text-right">TB 2+</th>
                    <th className="px-2 py-1 text-right">HR μ</th>
                    <th className="px-2 py-1 text-right">HR 1+</th>
                    <th className="px-2 py-1 text-right">act H</th>
                    <th className="px-2 py-1 text-right">act TB</th>
                    <th className="px-2 py-1 text-right">act HR</th>
                    <th className="px-2 py-1 text-right">act K</th>
                    <th className="px-2 py-1 text-left">Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {g.hitters.map((h) => (
                    <tr key={h.mlb_player_id} className="border-t border-zinc-900">
                      <td className="px-2 py-1 tabular-nums text-zinc-400">{h.lineup_slot ?? ""}</td>
                      <td className="px-2 py-1">{h.player_name}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{f2(h.h_mean)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{pct(h.hit_1plus)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{f2(h.tb_mean)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{pct(h.tb_2plus)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{f2(h.hr_mean)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{pct(h.hr_1plus)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{h.actual_h ?? "—"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{h.actual_tb ?? "—"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{h.actual_hr ?? "—"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{h.actual_k ?? "—"}</td>
                      <td className="px-2 py-1 text-[10px]">
                        {h.final ? (
                          <div className="flex flex-wrap gap-1">
                            <GradePill label="H1+" v={h.grade.hit_1plus} />
                            <GradePill label="TB2+" v={h.grade.tb_2plus} />
                            <GradePill label="HR1+" v={h.grade.hr_1plus} />
                          </div>
                        ) : (
                          <span className="text-zinc-500">{g.game_state === "live" ? "live" : "pending"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {g.pitchers.length > 0 && (
            <div className="overflow-x-auto border-t border-zinc-800">
              <table className="w-full text-xs">
                <thead className="bg-zinc-900/60 text-[10px] uppercase tracking-wide text-zinc-400">
                  <tr>
                    <th className="px-2 py-1 text-left">Pitcher</th>
                    <th className="px-2 py-1 text-right">K μ</th>
                    <th className="px-2 py-1 text-right">K P10–P90</th>
                    <th className="px-2 py-1 text-right">Outs μ</th>
                    <th className="px-2 py-1 text-right">Outs P10–P90</th>
                    <th className="px-2 py-1 text-right">act K</th>
                    <th className="px-2 py-1 text-right">act outs</th>
                    <th className="px-2 py-1 text-right">act BB</th>
                    <th className="px-2 py-1 text-right">act H</th>
                    <th className="px-2 py-1 text-right">act ER</th>
                  </tr>
                </thead>
                <tbody>
                  {g.pitchers.map((p) => (
                    <tr key={p.mlb_player_id} className="border-t border-zinc-900">
                      <td className="px-2 py-1">{p.player_name}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{f2(p.pk_mean)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-zinc-400">
                        {f2(p.pk_p10)}–{f2(p.pk_p90)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{f2(p.outs_mean)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-zinc-400">
                        {f2(p.outs_p10)}–{f2(p.outs_p90)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{p.actual_k ?? "—"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{p.actual_outs ?? "—"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{p.actual_bb ?? "—"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{p.actual_h ?? "—"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{p.actual_er ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function GameStatePill({ state }: { state: "pending" | "live" | "final" }) {
  const cls =
    state === "live"
      ? "bg-emerald-500/15 text-emerald-300 animate-pulse"
      : state === "final"
        ? "bg-zinc-700 text-zinc-200"
        : "bg-blue-500/15 text-blue-300";
  return <span className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}>{state}</span>;
}

function GradePill({ label, v }: { label: string; v: "Hit" | "Miss" | null }) {
  if (!v) return <span className="text-zinc-500">{label}: —</span>;
  const cls = v === "Hit" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300";
  return <span className={`rounded px-1.5 py-0.5 ${cls}`}>{label}: {v}</span>;
}
