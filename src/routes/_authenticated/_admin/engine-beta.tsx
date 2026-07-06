import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  getEngineBetaBoard,
  lockEngineBetaBoard,
  getEngineBetaGrading,
  listEngineBetaSnapshots,
  type BoardRow,
} from "@/lib/engine-beta/board.functions";
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

function todayIsoUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

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
  const [date, setDate] = useState(todayIsoUtc());
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

  const lockMut = useMutation({
    mutationFn: (opts: { newVersion?: boolean } = {}) => lockFn({ data: { date, newVersion: opts.newVersion } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["engine-beta-snapshots"] });
      qc.invalidateQueries({ queryKey: ["engine-beta-grading", date] });
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
  board: any; allRows: BoardRow[]; filteredRows: BoardRow[];
  isLoading: boolean; error: Error | null;
  openPlayer: string | null; setOpenPlayer: (v: string | null) => void;
  currentCategoryLabel: string;
}) {
  const { board, allRows, filteredRows, openPlayer, setOpenPlayer } = props;

  return (
    <>
      {/* Category tabs */}
      <div className="mt-6 space-y-2">
        <CategoryRow label="HITTERS" cats={HITTER_CATS} current={props.category} onPick={props.setCategory} />
        <CategoryRow label="PITCHERS" cats={PITCHER_CATS} current={props.category} onPick={props.setCategory} />
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
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
          {allRows.length} eligible · showing {filteredRows.length} · {props.currentCategoryLabel}
        </div>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-sm border border-[var(--border)]">
        <table className="w-full text-xs">
          <thead className="bg-[color-mix(in_oklab,var(--charcoal)_90%,transparent)] text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">
            <tr>
              <th className="px-2 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Player</th>
              <th className="px-2 py-2 text-left">Game</th>
              <th className="px-2 py-2 text-left">Lineup</th>
              <th className="px-2 py-2 text-right">Baseline μ</th>
              <th className="px-2 py-2 text-right">P(≥1)</th>
              <th className="px-2 py-2 text-right">Shadow Δ</th>
              <th className="px-2 py-2 text-right">Form</th>
              <th className="px-2 py-2 text-right">Score</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {props.isLoading ? (
              <tr><td className="px-2 py-4 text-[var(--warm-muted)]" colSpan={10}>Loading…</td></tr>
            ) : props.error ? (
              <tr><td className="px-2 py-4 text-red-400" colSpan={10}>{String(props.error.message)}</td></tr>
            ) : filteredRows.length === 0 ? (
              <tr><td className="px-2 py-4 text-[var(--warm-muted)]" colSpan={10}>No eligible players for this category on {props.date}.</td></tr>
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
                    <td className="px-2 py-2 text-[var(--warm-muted)]">
                      {r.matchup}
                      <div className="text-[10px]">{r.firstPitchAt ? new Date(r.firstPitchAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"} · {r.gameStatus ?? "—"}</div>
                    </td>
                    <td className="px-2 py-2">
                      <LineupPill state={r.lineupState} order={r.battingOrder} />
                    </td>
                    <td className="px-2 py-2 text-right text-[var(--cream)] mono">{fmt(r.baselineMean, r.role === "pitcher" ? 1 : 2)}</td>
                    <td className="px-2 py-2 text-right text-[var(--warm-muted)] mono">{pct(r.baselineProbAtLeast1)}</td>
                    <td className="px-2 py-2 text-right mono">
                      {r.shadowMean != null ? (
                        <span className={r.shadowDelta && r.shadowDelta > 0 ? "text-emerald-300" : r.shadowDelta && r.shadowDelta < 0 ? "text-rose-300" : "text-[var(--warm-muted)]"}>
                          {signedFmt(r.shadowDelta, 3)}
                        </span>
                      ) : <span className="text-[var(--warm-muted)]">—</span>}
                    </td>
                    <td className="px-2 py-2 text-right text-[10px] text-[var(--warm-muted)]">
                      {r.formApplied ? (
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
                      <td colSpan={10} className="px-4 py-3">
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
      <div className="text-[11px] text-[var(--warm-muted)]">
        <div>Baseline distribution — mean {fmt(row.baselineMean, 3)} · P50 {fmt(row.baselineP50)} · P90 {fmt(row.baselineP90)}</div>
        <div className="mt-1">Shadow mean — {fmt(row.shadowMean, 3)} · Δ {signedFmt(row.shadowDelta)}</div>
        <div className="mt-1">Form — {row.formReason}</div>
        <div className="mt-1">Forecast run — {row.forecastStatus} / {row.forecastClass} · generated {new Date(row.forecastGeneratedAt).toLocaleString()}</div>
        <div className="mt-3 text-[10px] uppercase tracking-[0.14em]">
          Experimental · private · not a probability or recommendation.
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
