import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  getEngineBetaBoard,
  lockEngineBetaBoard,
  getEngineBetaGrading,
  listEngineBetaSnapshots,
  getEngineBetaLockStatus,
  lockSingleGameNow,
  type BoardRow,
  type GameLockStatus,
} from "@/lib/engine-beta/board.functions";
import { getEngineBetaDataHealth, type HealthCard, type HealthStatus } from "@/lib/engine-beta/health.functions";
import { ENGINE_BETA_CATEGORIES, EXCLUDED_CATEGORIES, type EngineBetaCategoryKey } from "@/lib/engine-beta/categories";


export const Route = createFileRoute("/_authenticated/_admin/engine-beta")({
  head: () => ({
    meta: [
      { title: "Diamond Engine Beta — Private" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: EngineBetaPage,
});

import { todayInAppTz } from "@/lib/timezone";


function fmt(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(d);
}
function signedFmt(n: number | null | undefined, d = 3): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n); const s = v.toFixed(d);
  return v > 0 ? `+${s}` : s;
}
function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(1)}%`;
}

const HITTER_CATS = ENGINE_BETA_CATEGORIES.filter((c) => c.role === "hitter");
const PITCHER_CATS = ENGINE_BETA_CATEGORIES.filter((c) => c.role === "pitcher");

const LIMITS = [5, 10, 25, 50, 9999] as const;
const LIMIT_LABELS: Record<number, string> = { 5: "Top 5", 10: "Top 10", 25: "Top 25", 50: "Top 50", 9999: "All" };

function EngineBetaPage() {
  const [date, setDate] = useState(todayInAppTz());
  const [category, setCategory] = useState<EngineBetaCategoryKey>("H");
  const [limit, setLimit] = useState<number>(25);
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [gameFilter, setGameFilter] = useState<string>("all");
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [readinessFilter, setReadinessFilter] = useState<"ready" | "watch_up" | "all">("ready");
  const [openPlayer, setOpenPlayer] = useState<string | null>(null);
  const [tab, setTab] = useState<"board" | "grading">("board");

  const boardFn = useServerFn(getEngineBetaBoard);
  const lockFn = useServerFn(lockEngineBetaBoard);
  const gradingFn = useServerFn(getEngineBetaGrading);
  const snapListFn = useServerFn(listEngineBetaSnapshots);
  const lockStatusFn = useServerFn(getEngineBetaLockStatus);
  const lockGameFn = useServerFn(lockSingleGameNow);
  const healthFn = useServerFn(getEngineBetaDataHealth);
  const qc = useQueryClient();

  const boardQ = useQuery({
    queryKey: ["engine-beta-board", date, category],
    queryFn: () => boardFn({ data: { date, category } }),
  });
  const gradingQ = useQuery({
    queryKey: ["engine-beta-grading", date],
    queryFn: () => gradingFn({ data: { date } }),
    enabled: tab === "grading",
  });
  const snapQ = useQuery({
    queryKey: ["engine-beta-snapshots"],
    queryFn: () => snapListFn(),
  });
  const lockStatusQ = useQuery({
    queryKey: ["engine-beta-lock-status", date],
    queryFn: () => lockStatusFn({ data: { date } }),
    refetchInterval: 60_000,
  });
  const healthQ = useQuery({
    queryKey: ["engine-beta-health", date],
    queryFn: () => healthFn({ data: { date } }),
    refetchInterval: 60_000,
  });

  const lockMut = useMutation({
    mutationFn: (opts: { newVersion?: boolean } = {}) => lockFn({ data: { date, newVersion: opts.newVersion } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["engine-beta-snapshots"] });
      qc.invalidateQueries({ queryKey: ["engine-beta-grading", date] });
      qc.invalidateQueries({ queryKey: ["engine-beta-lock-status", date] });
    },
  });
  const lockGameMut = useMutation({
    mutationFn: (gameId: string) => lockGameFn({ data: { gameId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["engine-beta-snapshots"] });
      qc.invalidateQueries({ queryKey: ["engine-beta-lock-status", date] });
      qc.invalidateQueries({ queryKey: ["engine-beta-board", date] });
    },
  });


  const priorSnapshotForDate = (snapQ.data?.snapshots ?? []).some((s) => s.slate_date === date);

  const handleLock = () => {
    if (priorSnapshotForDate) {
      const ok = window.confirm(`A locked snapshot already exists for ${date}. Prior snapshots are immutable. Record a new version?`);
      if (!ok) return;
      lockMut.mutate({ newVersion: true });
    } else {
      lockMut.mutate({});
    }
  };

  const board = boardQ.data;
  const allRows: BoardRow[] = board?.rows ?? [];
  const filteredRows = useMemo(() => {
    let rs = allRows;
    if (readinessFilter === "ready") rs = rs.filter((r) => r.readiness === "ready");
    else if (readinessFilter === "watch_up") rs = rs.filter((r) => r.readiness !== "not_ready");
    if (teamFilter !== "all") rs = rs.filter((r) => r.teamAbbr === teamFilter);
    if (gameFilter !== "all") rs = rs.filter((r) => r.gameId === gameFilter);
    if (confirmedOnly) rs = rs.filter((r) => r.lineupState === "confirmed" || r.lineupState === "locked");
    return rs.slice(0, limit);
  }, [allRows, readinessFilter, teamFilter, gameFilter, confirmedOnly, limit]);

  const currentCategory = ENGINE_BETA_CATEGORIES.find((c) => c.key === category)!;
  const readyCount = allRows.filter((r) => r.readiness === "ready").length;
  const watchCount = allRows.filter((r) => r.readiness === "watch").length;
  const notReadyCount = allRows.filter((r) => r.readiness === "not_ready").length;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      {/* Header */}
      <div className="eyebrow text-[var(--primary)]">Diamond · Admin · Private</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-3">
        <h1 className="text-[26px] leading-tight text-[var(--cream)] md:text-[36px]">
          Diamond Engine Beta
        </h1>
        <span className="inline-flex items-center rounded-sm border border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--warm-muted)]">
          High-Outcome Research Board · Experimental
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-[var(--warm-muted)]">
        Private research cockpit for ranking model-favored player-days within a single stat category. No sportsbook
        line, market price, edge, pick, or recommendation is involved. Every score is experimental and every
        probability names its exact event.
      </p>

      {/* Tabs */}
      <div className="mt-6 flex gap-2">
        {(["board", "grading"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-sm border px-3 py-1.5 text-xs uppercase tracking-[0.16em] transition-colors ${
              tab === t ? "border-[var(--primary)] text-[var(--cream)]" : "border-[var(--border)] text-[var(--warm-muted)] hover:border-[var(--brass)]"
            }`}>{t === "board" ? "Board" : "Grading"}</button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="rounded-sm border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--cream)]" />
          <button onClick={handleLock}
            disabled={lockMut.isPending}
            className="rounded-sm border border-[var(--brass)] px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-[var(--cream)] transition-colors hover:bg-[color-mix(in_oklab,var(--brass)_20%,transparent)] disabled:opacity-50">
            {lockMut.isPending ? "Locking…" : priorSnapshotForDate ? "Lock New Version" : "Lock Beta Board"}
          </button>
        </div>
      </div>

      {lockMut.error ? (
        <div className="mt-3 rounded-sm border border-rose-500/40 bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] px-3 py-2 text-xs text-rose-300">
          {(lockMut.error as Error).message}
        </div>
      ) : lockMut.data ? (
        <div className="mt-3 rounded-sm border border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] px-3 py-2 text-xs text-[var(--warm-muted)]">
          Snapshot locked · v{lockMut.data.version} · {lockMut.data.rowsWritten} rows across {lockMut.data.categories.length} categories.
        </div>
      ) : null}

      {/* Today's Lock Status — per-game pregame auto-lock visibility */}
      <LockStatusPanel
        data={lockStatusQ.data}
        isLoading={lockStatusQ.isLoading}
        onLockGame={(gameId) => lockGameMut.mutate(gameId)}
        lockingGameId={lockGameMut.isPending ? (lockGameMut.variables ?? null) : null}
        lockError={lockGameMut.error ? (lockGameMut.error as Error).message : null}
      />

      {tab === "board" ? (

        <BoardView
          date={date}
          category={category}
          setCategory={setCategory}
          limit={limit}
          setLimit={setLimit}
          teamFilter={teamFilter}
          setTeamFilter={setTeamFilter}
          gameFilter={gameFilter}
          setGameFilter={setGameFilter}
          confirmedOnly={confirmedOnly}
          setConfirmedOnly={setConfirmedOnly}
          readinessFilter={readinessFilter}
          setReadinessFilter={setReadinessFilter}
          board={board}
          allRows={allRows}
          filteredRows={filteredRows}
          isLoading={boardQ.isLoading}
          error={boardQ.error as Error | null}
          openPlayer={openPlayer}
          setOpenPlayer={setOpenPlayer}
          currentCategory={currentCategory}
          readyCount={readyCount}
          watchCount={watchCount}
          notReadyCount={notReadyCount}
        />
      ) : (
        <GradingView data={gradingQ.data} isLoading={gradingQ.isLoading} />
      )}

      {/* Snapshots */}
      <div className="mt-10 border-t border-[var(--border)] pt-4">
        <div className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
          Recent locked snapshots
        </div>
        <div className="mt-2 grid grid-cols-1 gap-1.5 md:grid-cols-2">
          {(snapQ.data?.snapshots ?? []).map((s) => (
            <div key={s.id} className="rounded-sm border border-[var(--border)] px-3 py-2 text-xs text-[var(--cream)]">
              <div className="flex items-center justify-between">
                <span>{s.slate_date}</span>
                <span className="mono text-[10px] text-[var(--warm-muted)]">{new Date(s.created_at).toLocaleString()}</span>
              </div>
              {s.notes ? <div className="mt-1 text-[11px] text-[var(--warm-muted)]">{s.notes}</div> : null}
            </div>
          ))}
          {snapQ.data && snapQ.data.snapshots.length === 0 ? (
            <div className="text-xs text-[var(--warm-muted)]">No snapshots yet — Lock Beta Board to record one.</div>
          ) : null}
        </div>
      </div>

      {/* Categories not modeled */}
      <div className="mt-10 border-t border-[var(--border)] pt-4">
        <div className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
          Not currently modeled
        </div>
        <ul className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-[var(--warm-muted)] md:grid-cols-2">
          {EXCLUDED_CATEGORIES.map((c) => (
            <li key={c.key}><span className="text-[var(--cream)]">{c.label}</span> — {c.reason}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function BoardView(props: {
  date: string;
  category: EngineBetaCategoryKey;
  setCategory: (k: EngineBetaCategoryKey) => void;
  limit: number; setLimit: (n: number) => void;
  teamFilter: string; setTeamFilter: (v: string) => void;
  gameFilter: string; setGameFilter: (v: string) => void;
  confirmedOnly: boolean; setConfirmedOnly: (v: boolean) => void;
  readinessFilter: "ready" | "watch_up" | "all"; setReadinessFilter: (v: "ready" | "watch_up" | "all") => void;
  board: any; allRows: BoardRow[]; filteredRows: BoardRow[];
  isLoading: boolean; error: Error | null;
  openPlayer: string | null; setOpenPlayer: (v: string | null) => void;
  currentCategory: (typeof ENGINE_BETA_CATEGORIES)[number];
  readyCount: number; watchCount: number; notReadyCount: number;
}) {
  const { board, allRows, filteredRows, openPlayer, setOpenPlayer, currentCategory } = props;
  const meanHeader = `Baseline μ (${currentCategory.meanUnit})`;
  const probHeader = currentCategory.hasStoredProbAtThreshold ? `P(${currentCategory.eventLabel})` : "P(event)";

  return (
    <>
      {/* Category tabs */}
      <div className="mt-6 space-y-2">
        <CategoryRow label="HITTERS" cats={HITTER_CATS} current={props.category} onPick={props.setCategory} />
        <CategoryRow label="PITCHERS" cats={PITCHER_CATS} current={props.category} onPick={props.setCategory} />
      </div>

      {/* Category context strip — event + unit + prob availability */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--warm-muted)]">
        <span><span className="text-[var(--cream)]">Event:</span> {currentCategory.eventLabel}</span>
        <span><span className="text-[var(--cream)]">Mean:</span> {currentCategory.meanUnit}</span>
        <span><span className="text-[var(--cream)]">Threshold:</span> &gt; {currentCategory.threshold} {currentCategory.higherIsBetter ? "(higher = favorable)" : "(lower = favorable)"}</span>
        {!currentCategory.hasStoredProbAtThreshold ? (
          <span className="text-amber-300/80">P({currentCategory.eventLabel}) not stored — showing expected mean only.</span>
        ) : null}
      </div>

      {/* Readiness segmented control */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">Readiness</span>
        {([
          { k: "ready", label: `Ready (${props.readyCount})` },
          { k: "watch_up", label: `+ Watch (${props.readyCount + props.watchCount})` },
          { k: "all", label: `All (${allRows.length})` },
        ] as const).map((o) => (
          <button key={o.k} onClick={() => props.setReadinessFilter(o.k)}
            className={`rounded-sm border px-2.5 py-1 text-[11px] transition-colors ${
              props.readinessFilter === o.k
                ? "border-[var(--primary)] text-[var(--cream)]"
                : "border-[var(--border)] text-[var(--warm-muted)] hover:border-[var(--brass)]"
            }`}>{o.label}</button>
        ))}
        <span className="text-[10px] text-[var(--warm-muted)]">Not ready: {props.notReadyCount}</span>
      </div>

      {/* Filters */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={props.limit} onChange={(e) => props.setLimit(Number(e.target.value))}
          className="rounded-sm border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--cream)]">
          {LIMITS.map((n) => <option key={n} value={n} className="bg-[var(--charcoal)]">{LIMIT_LABELS[n]}</option>)}
        </select>
        <select value={props.teamFilter} onChange={(e) => props.setTeamFilter(e.target.value)}
          className="rounded-sm border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--cream)]">
          <option value="all" className="bg-[var(--charcoal)]">All teams</option>
          {(board?.teams ?? []).map((t: any) => <option key={t.abbr} value={t.abbr} className="bg-[var(--charcoal)]">{t.abbr}</option>)}
        </select>
        <select value={props.gameFilter} onChange={(e) => props.setGameFilter(e.target.value)}
          className="rounded-sm border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--cream)]">
          <option value="all" className="bg-[var(--charcoal)]">All games</option>
          {(board?.games ?? []).map((g: any) => <option key={g.gameId} value={g.gameId} className="bg-[var(--charcoal)]">{g.matchup}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-[var(--warm-muted)]">
          <input type="checkbox" checked={props.confirmedOnly} onChange={(e) => props.setConfirmedOnly(e.target.checked)} />
          Confirmed lineups only
        </label>
        <div className="ml-auto text-[11px] text-[var(--warm-muted)]">
          {allRows.length} eligible · showing {filteredRows.length} · {currentCategory.label}
        </div>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-sm border border-[var(--border)]">
        <table className="w-full text-xs">
          <thead className="bg-[color-mix(in_oklab,var(--charcoal)_90%,transparent)] text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">
            <tr>
              <th className="px-2 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Player</th>
              <th className="px-2 py-2 text-left">Ready</th>
              <th className="px-2 py-2 text-left">Game</th>
              <th className="px-2 py-2 text-left">Lineup</th>
              <th className="px-2 py-2 text-right" title={meanHeader}>Baseline μ</th>
              <th className="px-2 py-2 text-right" title={probHeader}>{probHeader}</th>
              <th className="px-2 py-2 text-right" title="Form-shadow Δ on the same event mean (experimental, not applied to public forecast)">Form Δμ</th>
              <th className="px-2 py-2 text-right">Form event</th>
              <th className="px-2 py-2 text-right">Score</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {props.isLoading ? (
              <tr><td className="px-2 py-4 text-[var(--warm-muted)]" colSpan={11}>Loading…</td></tr>
            ) : props.error ? (
              <tr><td className="px-2 py-4 text-red-400" colSpan={11}>{String(props.error.message)}</td></tr>
            ) : filteredRows.length === 0 ? (
              <tr><td className="px-2 py-4 text-[var(--warm-muted)]" colSpan={11}>No eligible players match these filters on {props.date}.</td></tr>
            ) : filteredRows.map((r, i) => {
              const open = openPlayer === r.playerId;
              return (
                <>
                  <tr key={r.playerId} className="border-t border-[var(--border)] hover:bg-[color-mix(in_oklab,var(--charcoal)_60%,transparent)]">
                    <td className="px-2 py-2 text-[var(--warm-muted)]">{i + 1}</td>
                    <td className="px-2 py-2 text-[var(--cream)]">
                      <Link to="/players/$playerId" params={{ playerId: r.playerId }} className="hover:underline">{r.name}</Link>
                      <div className="text-[10px] text-[var(--warm-muted)]">{r.teamAbbr ?? "—"} · {r.role}</div>
                    </td>
                    <td className="px-2 py-2">
                      <ReadinessPill state={r.readiness} reason={r.readinessReason} />
                    </td>
                    <td className="px-2 py-2 text-[var(--warm-muted)]">
                      {r.matchup}
                      <div className="text-[10px]">{r.firstPitchAt ? new Date(r.firstPitchAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"} · {r.gameStatus ?? "—"}</div>
                    </td>
                    <td className="px-2 py-2">
                      <LineupPill state={r.lineupState} order={r.battingOrder} />
                    </td>
                    <td className="px-2 py-2 text-right text-[var(--cream)] mono" title={`${r.meanUnit}`}>{fmt(r.baselineMean, r.role === "pitcher" ? 1 : 2)}</td>
                    <td className="px-2 py-2 text-right text-[var(--warm-muted)] mono" title={probHeader}>
                      {r.probAtThreshold != null ? pct(r.probAtThreshold) : <span title="No P(event) stored for this category">—</span>}
                    </td>
                    <td className="px-2 py-2 text-right mono">
                      {r.shadowMean != null && r.shadowDelta != null ? (
                        <span className={r.shadowDelta > 0 ? "text-emerald-300" : r.shadowDelta < 0 ? "text-rose-300" : "text-[var(--warm-muted)]"}>
                          {signedFmt(r.shadowDelta, 3)}
                        </span>
                      ) : <span className="text-[var(--warm-muted)]" title="No form-shadow output for this category">—</span>}
                    </td>
                    <td className="px-2 py-2 text-right text-[10px] text-[var(--warm-muted)]">
                      {r.formApplied && r.formHeadlineEvent ? (
                        <span>{r.formHeadlineEvent} {signedFmt(r.formHeadlineDelta)}</span>
                      ) : (
                        <span>None</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <ScoreBadge score={r.score} />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button onClick={() => setOpenPlayer(open ? null : r.playerId)}
                        className="text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)] hover:text-[var(--cream)]">
                        {open ? "Close" : "Details"}
                      </button>
                    </td>
                  </tr>
                  {open ? (
                    <tr className="bg-[color-mix(in_oklab,var(--charcoal)_92%,transparent)]">
                      <td colSpan={11} className="px-4 py-3">
                        <ScoreBreakdown row={r} weights={board?.scoreWeights} />
                      </td>
                    </tr>
                  ) : null}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ReadinessPill({ state, reason }: { state: "ready" | "watch" | "not_ready"; reason: string }) {
  const cls =
    state === "ready" ? "border-emerald-500/50 text-emerald-300"
    : state === "watch" ? "border-amber-500/50 text-amber-300"
    : "border-[var(--border)] text-[var(--warm-muted)]";
  const label = state === "ready" ? "Ready" : state === "watch" ? "Watch" : "Not Ready";
  return (
    <span title={reason} className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] ${cls}`}>
      {label}
    </span>
  );
}

function CategoryRow({ label, cats, current, onPick }: { label: string; cats: typeof ENGINE_BETA_CATEGORIES; current: EngineBetaCategoryKey; onPick: (k: EngineBetaCategoryKey) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mono w-16 text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">{label}</span>
      {cats.map((c) => (
        <button key={c.key} onClick={() => onPick(c.key)}
          className={`rounded-sm border px-2.5 py-1 text-xs transition-colors ${
            current === c.key ? "border-[var(--primary)] text-[var(--cream)]" : "border-[var(--border)] text-[var(--warm-muted)] hover:border-[var(--brass)]"
          }`}>{c.label}</button>
      ))}
    </div>
  );
}

function LineupPill({ state, order }: { state: string; order: number | null }) {
  const good = state === "confirmed" || state === "locked";
  const proj = state === "projected";
  const cls = good ? "border-emerald-500/40 text-emerald-300" : proj ? "border-amber-500/40 text-amber-300" : "border-[var(--border)] text-[var(--warm-muted)]";
  return (
    <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] ${cls}`}>
      {state}{order ? ` · #${order}` : ""}
    </span>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 80 ? "text-emerald-300 border-emerald-500/40" : score >= 60 ? "text-amber-300 border-amber-500/40" : "text-[var(--warm-muted)] border-[var(--border)]";
  return (
    <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-xs mono ${tone}`} title="Experimental — not a probability or recommendation">
      {score}
      <span className="ml-1 text-[9px] uppercase tracking-[0.14em] opacity-60">exp</span>
    </span>
  );
}

function ScoreBreakdown({ row, weights }: { row: BoardRow; weights: any }) {
  const c = row.scoreComponents;
  const parts = [
    { name: "Baseline strength", raw: `μ ${fmt(c.baseline.raw, 3)}`, score: c.baseline.score, weight: c.baseline.weight },
    { name: "Form alignment", raw: c.form.raw != null ? `Δ ${signedFmt(c.form.raw, 3)} rate` : "no adjustment", score: c.form.score, weight: c.form.weight },
    { name: "Opportunity", raw: String(c.opportunity.raw), score: c.opportunity.score, weight: c.opportunity.weight },
    { name: "Freshness", raw: c.freshness.raw != null ? `${c.freshness.raw}h old` : "unknown", score: c.freshness.score, weight: c.freshness.weight },
    { name: "Sample size", raw: c.uncertainty.raw != null ? `${c.uncertainty.raw} recent PA/BF` : "unknown", score: c.uncertainty.score, weight: c.uncertainty.weight },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div>
        <div className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">Score components (weights sum 100)</div>
        <table className="mt-2 w-full text-[11px]">
          <tbody>
            {parts.map((p) => (
              <tr key={p.name}>
                <td className="py-1 text-[var(--warm-muted)]">{p.name}</td>
                <td className="py-1 text-[var(--warm-muted)]">{p.raw}</td>
                <td className="py-1 text-right text-[var(--cream)] mono">{(p.score * 100).toFixed(0)}</td>
                <td className="py-1 pl-2 text-right text-[var(--warm-muted)] mono">×{p.weight}</td>
              </tr>
            ))}
            <tr className="border-t border-[var(--border)]">
              <td className="py-1 text-[var(--cream)]">Total (experimental)</td>
              <td />
              <td colSpan={2} className="py-1 text-right text-[var(--cream)] mono">{c.total}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="space-y-3 text-[11px] text-[var(--warm-muted)]">
        <div className="rounded-sm border border-[var(--border)] p-2">
          <div className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">Baseline projection</div>
          <div className="mt-1 text-[var(--cream)]">
            Expected {row.meanUnit}: <span className="mono">{fmt(row.baselineMean, 3)}</span>
          </div>
          <div>P50 <span className="mono">{fmt(row.baselineP50)}</span> · P90 <span className="mono">{fmt(row.baselineP90)}</span>{row.probAtThreshold != null ? <> · P({row.eventLabel}) <span className="mono">{pct(row.probAtThreshold)}</span></> : null}</div>
        </div>
        <div className="rounded-sm border border-[var(--border)] p-2">
          <div className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">Form-shadow shift (experimental — not applied to public forecast)</div>
          <div className="mt-1">
            Shadow mean: <span className="mono text-[var(--cream)]">{fmt(row.shadowMean, 3)}</span> · Δ <span className="mono">{signedFmt(row.shadowDelta)}</span>
          </div>
          <div>{row.formReason}</div>
        </div>
        <div className="rounded-sm border border-[var(--border)] p-2">
          <div className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">Engine Beta score (experimental)</div>
          <div className="mt-1">Score <span className="mono text-[var(--cream)]">{c.total}</span> / 100 · ranked within {row.role === "hitter" ? "hitters" : "pitchers"} for this date + category.</div>
          <div>Readiness: <span className="text-[var(--cream)]">{row.readiness}</span> — {row.readinessReason}</div>
        </div>
        <div>Forecast run — {row.forecastStatus} / {row.forecastClass} · generated {new Date(row.forecastGeneratedAt).toLocaleString()}</div>
        <div className="text-[10px] uppercase tracking-[0.14em]">
          Experimental · private · not a probability, edge, pick, or recommendation.
        </div>
      </div>
    </div>
  );
}

function GradingView({ data, isLoading }: { data: any; isLoading: boolean }) {
  if (isLoading) return <div className="mt-6 text-sm text-[var(--warm-muted)]">Loading grading…</div>;
  if (!data || !data.snapshotId) return <div className="mt-6 text-sm text-[var(--warm-muted)]">No locked snapshot for this date yet.</div>;
  return (
    <div className="mt-6 space-y-6">
      <div>
        <div className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">
          Snapshot · {data.slateDate} · locked {new Date(data.createdAt).toLocaleString()}
        </div>
        <div className="mt-1 text-xs text-[var(--warm-muted)]">
          {data.totalRows} rows · {data.gradedRows} graded {data.incomplete ? "· some games not yet final" : ""}
        </div>
      </div>

      <div>
        <div className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">Score buckets</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {(["80-100","60-79","0-59"] as const).map((b) => {
            const bk = data.byBucket[b];
            return (
              <div key={b} className="rounded-sm border border-[var(--border)] px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">Score {b}</div>
                <div className="mt-1 text-lg text-[var(--cream)] mono">{bk.hitRate != null ? `${(bk.hitRate * 100).toFixed(1)}%` : "—"}</div>
                <div className="text-[10px] text-[var(--warm-muted)]">{bk.hits}/{bk.graded} hits · {bk.total} total</div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">By category</div>
        <div className="mt-2 overflow-x-auto rounded-sm border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead className="bg-[color-mix(in_oklab,var(--charcoal)_90%,transparent)] text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">
              <tr>
                <th className="px-2 py-2 text-left">Category</th>
                <th className="px-2 py-2 text-right">Total</th>
                <th className="px-2 py-2 text-right">Graded</th>
                <th className="px-2 py-2 text-right">Hit rate</th>
                <th className="px-2 py-2 text-right">Baseline MAE</th>
                <th className="px-2 py-2 text-right">Shadow MAE</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.byCategory).map(([k, v]: [string, any]) => (
                <tr key={k} className="border-t border-[var(--border)]">
                  <td className="px-2 py-2 text-[var(--cream)]">{k}</td>
                  <td className="px-2 py-2 text-right text-[var(--warm-muted)]">{v.total}</td>
                  <td className="px-2 py-2 text-right text-[var(--warm-muted)]">{v.graded}</td>
                  <td className="px-2 py-2 text-right mono text-[var(--cream)]">{v.hitRate != null ? `${(v.hitRate * 100).toFixed(1)}%` : "—"}</td>
                  <td className="px-2 py-2 text-right mono text-[var(--warm-muted)]">{v.baselineMae ?? "—"}</td>
                  <td className="px-2 py-2 text-right mono text-[var(--warm-muted)]">{v.shadowMae ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Today's Lock Status — per-game pregame auto-lock panel
// ============================================================================

function LockStatusBadge({ status }: { status: GameLockStatus["status"] }) {
  const map: Record<GameLockStatus["status"], { label: string; cls: string }> = {
    auto_locked:      { label: "Auto-locked",     cls: "border-emerald-500/50 text-emerald-300" },
    manually_locked:  { label: "Manually locked", cls: "border-sky-500/50 text-sky-300" },
    missed_pregame:   { label: "Missed pregame",  cls: "border-rose-500/50 text-rose-300" },
    ready_to_lock:    { label: "Ready to lock",   cls: "border-[var(--brass)] text-[var(--cream)]" },
    started:          { label: "Game live/final", cls: "border-[var(--border)] text-[var(--warm-muted)]" },
    not_ready:        { label: "Not ready",       cls: "border-[var(--border)] text-[var(--warm-muted)]" },
  };
  const s = map[status];
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] ${s.cls}`}>
      {s.label}
    </span>
  );
}

function LockStatusPanel(props: {
  data: any;
  isLoading: boolean;
  onLockGame: (gameId: string) => void;
  lockingGameId: string | null;
  lockError: string | null;
}) {
  const { data, isLoading, onLockGame, lockingGameId, lockError } = props;
  if (isLoading) {
    return (
      <div className="mt-8 rounded-sm border border-[var(--border)] px-3 py-3 text-xs text-[var(--warm-muted)]">
        Loading lock status…
      </div>
    );
  }
  if (!data || !data.games?.length) {
    return (
      <div className="mt-8 rounded-sm border border-[var(--border)] px-3 py-3 text-xs text-[var(--warm-muted)]">
        No games on this slate. Automatic locking has nothing to do.
      </div>
    );
  }

  const summary = data.games.reduce(
    (acc: any, g: GameLockStatus) => {
      acc[g.status] = (acc[g.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="mt-8 border-t border-[var(--border)] pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
            Today’s lock status · per-game
          </div>
          <div className="mt-1 text-[11px] text-[var(--warm-muted)]">
            Auto-lock target: first pitch − {data.lockLeadMinutes}m · missed grace {data.missedGraceMinutes}m. Never locks
            after first pitch. Automatic snapshots are immutable.
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">
          <span>Locked: <span className="text-emerald-300">{(summary.auto_locked ?? 0) + (summary.manually_locked ?? 0)}</span></span>
          <span>· Ready: <span className="text-[var(--cream)]">{summary.ready_to_lock ?? 0}</span></span>
          <span>· Missed: <span className="text-rose-300">{summary.missed_pregame ?? 0}</span></span>
          <span>· Not ready: <span>{summary.not_ready ?? 0}</span></span>
          <span>· Live/Final: <span>{summary.started ?? 0}</span></span>
        </div>
      </div>
      {lockError ? (
        <div className="mt-2 rounded-sm border border-rose-500/40 px-3 py-2 text-xs text-rose-300">{lockError}</div>
      ) : null}
      <div className="mt-3 overflow-hidden rounded-sm border border-[var(--border)]">
        <table className="w-full text-left text-[11px]">
          <thead className="bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">
            <tr>
              <th className="px-3 py-2">Game</th>
              <th className="px-3 py-2">First pitch (CT)</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Lock detail</th>
              <th className="px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="text-[var(--cream)]">
            {data.games.map((g: GameLockStatus) => {
              const fp = g.firstPitchAt ? new Date(g.firstPitchAt).toLocaleString(undefined, { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }) : "—";
              const locked = g.autoLock || g.manualLock;
              const canManual = g.status === "ready_to_lock" || g.status === "not_ready";
              const disabled = !canManual || g.hasStarted || !!locked || lockingGameId === g.gameId;
              return (
                <tr key={g.gameId} className="border-t border-[var(--border)]/60">
                  <td className="px-3 py-2 font-medium">
                    {g.matchup} <span className="mono text-[10px] text-[var(--warm-muted)]">#{g.gamePk}</span>
                  </td>
                  <td className="px-3 py-2 mono text-[var(--warm-muted)]">{fp}</td>
                  <td className="px-3 py-2"><LockStatusBadge status={g.status} /></td>
                  <td className="px-3 py-2 text-[var(--warm-muted)]">
                    {g.autoLock && !g.autoLock.missed ? (
                      <>Auto · {new Date(g.autoLock.createdAt).toLocaleTimeString([], { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} · {g.autoLock.rows} rows</>
                    ) : g.autoLock?.missed ? (
                      <>Missed · {g.autoLock.reason}</>
                    ) : g.manualLock ? (
                      <>Manual · {new Date(g.manualLock.createdAt).toLocaleTimeString([], { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} · {g.manualLock.rows} rows</>
                    ) : (
                      g.reason
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      disabled={disabled}
                      onClick={() => {
                        if (!window.confirm(`Lock ${g.matchup} now? This is an immutable snapshot.`)) return;
                        onLockGame(g.gameId);
                      }}
                      className="rounded-sm border border-[var(--brass)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--cream)] transition-colors hover:bg-[color-mix(in_oklab,var(--brass)_20%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {lockingGameId === g.gameId ? "Locking…" : "Lock this game"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
