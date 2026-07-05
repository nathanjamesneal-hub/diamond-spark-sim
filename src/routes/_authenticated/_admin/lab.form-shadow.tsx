import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  getFormShadowDiagnostics,
  type ShadowPlayerRow,
} from "@/lib/form-v2/diagnostics.functions";

export const Route = createFileRoute("/_authenticated/_admin/lab/form-shadow")({
  head: () => ({
    meta: [
      { title: "Diamond V2 · Form Shadow — Admin Diagnostics" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: FormShadowPage,
});

const SHADOW_BADGE = "Shadow only — not used in public forecasts";

function fmt(n: number | null | undefined, digits = 3): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function signedFmt(n: number | null | undefined, digits = 3): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "—";
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function FormShadowPage() {
  const fetchFn = useServerFn(getFormShadowDiagnostics);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [openPlayerIdx, setOpenPlayerIdx] = useState<number | null>(null);
  const [filterApplied, setFilterApplied] = useState<"all" | "applied" | "insufficient">("all");

  const q = useQuery({
    queryKey: ["form-shadow-diagnostics", selectedRunId ?? "latest"],
    queryFn: () => fetchFn({ data: selectedRunId ? { runId: selectedRunId } : {} }),
  });

  const data = q.data;
  const run = data?.latest.run;
  const players = data?.latest.players ?? [];

  const filteredPlayers = useMemo(() => {
    if (filterApplied === "applied") return players.filter((p) => p.applied);
    if (filterApplied === "insufficient") return players.filter((p) => !p.applied);
    return players;
  }, [players, filterApplied]);

  const openPlayer = openPlayerIdx != null ? filteredPlayers[openPlayerIdx] ?? null : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-10">
      {/* Header */}
      <div className="eyebrow text-[var(--primary)]">Diamond V2 · Admin</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-3">
        <h1 className="text-[26px] leading-tight text-[var(--cream)] md:text-[36px]">
          Form Shadow
        </h1>
        <span className="inline-flex items-center rounded-sm border border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--warm-muted)]">
          {SHADOW_BADGE}
        </span>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-[var(--warm-muted)]">
        Diagnostic view of the form-adjusted Monte Carlo shadow output. Data on this page is
        never used to compute public Diamond forecasts, Diamond Live movers, probabilities, or
        rankings.
      </p>

      {/* Summary strip */}
      <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCell label="Shadow runs" value={String(data?.totals.shadowRuns ?? "—")} />
        <StatCell label="Player outputs" value={String(data?.totals.playerOutputs ?? "—")} />
        <StatCell label="Latest slate" value={data?.totals.latestSlateDate ?? "—"} />
        <StatCell
          label="Raw events refreshed"
          value={relTime(data?.totals.rawEventsFetchedAt)}
          sub={data?.totals.rawEventsSource ? `via ${data.totals.rawEventsSource}` : undefined}
        />
      </div>

      {q.isLoading && !data ? (
        <div className="mt-8 text-sm text-[var(--warm-muted)]">Loading shadow diagnostics…</div>
      ) : q.error ? (
        <div className="mt-8 text-sm text-red-400">{(q.error as Error).message}</div>
      ) : !run ? (
        <div className="mt-8 text-sm text-[var(--warm-muted)]">
          No form-shadow runs recorded yet. Publish a baseline forecast to trigger a shadow run.
        </div>
      ) : (
        <>
          {/* Run picker */}
          {data && data.runs.length > 1 ? (
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
                Run
              </span>
              <select
                className="rounded-sm border border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] px-2 py-1 text-xs text-[var(--cream)]"
                value={run.runId}
                onChange={(e) => {
                  setSelectedRunId(e.target.value);
                  setOpenPlayerIdx(null);
                }}
              >
                {data.runs.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {r.slateDate} · MLB {r.gamePk} · {r.applied}/{r.totalPlayers} adj
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {/* Run header */}
          <div className="mt-6 rounded-sm border border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] p-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <MetaCell label="Matchup" value={run.matchup} />
              <MetaCell label="Slate date" value={run.slateDate} />
              <MetaCell label="Game PK" value={String(run.gamePk)} />
              <MetaCell label="Created" value={relTime(run.createdAt)} sub={new Date(run.createdAt).toISOString()} />
              <MetaCell label="Seed" value={String(run.seed)} />
              <MetaCell label="Iterations" value={String(run.iterations)} />
              <MetaCell label="Form window" value={`${run.formWindowDays} days trailing`} />
              <MetaCell label="Model" value={run.modelVersion} />
            </div>
          </div>

          {/* Run summary */}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCell label="Player outputs" value={String(players.length)} />
            <StatCell label="Applied adjustments" value={String(data!.latest.applied)} />
            <StatCell
              label="Insufficient sample"
              value={String(data!.latest.insufficient)}
              sub="No adjustment applied"
            />
            <StatCell
              label="Actuals available"
              value={String(data!.latest.withActuals)}
              sub="Final-game only"
            />
          </div>

          {/* Filter */}
          <div className="mt-6 flex items-center gap-2">
            <span className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
              Filter
            </span>
            {(["all", "applied", "insufficient"] as const).map((k) => (
              <button
                key={k}
                onClick={() => {
                  setFilterApplied(k);
                  setOpenPlayerIdx(null);
                }}
                className={`rounded-sm border px-2 py-1 text-[11px] uppercase tracking-[0.14em] transition-colors ${
                  filterApplied === k
                    ? "border-[var(--primary)] text-[var(--cream)]"
                    : "border-[var(--border)] text-[var(--warm-muted)] hover:text-[var(--cream)]"
                }`}
              >
                {k}
              </button>
            ))}
          </div>

          {/* Player table */}
          <div className="mt-3 overflow-x-auto rounded-sm border border-[var(--border)]">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] text-[10px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">
                <tr>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Team</th>
                  <th className="px-3 py-2">Recent</th>
                  <th className="px-3 py-2">Season</th>
                  <th className="px-3 py-2">Headline event</th>
                  <th className="px-3 py-2 text-right">Baseline μ</th>
                  <th className="px-3 py-2 text-right">Shadow μ</th>
                  <th className="px-3 py-2 text-right">Δ</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredPlayers.map((p, i) => {
                  const headline =
                    (p.headlineEvent && p.events.find((e) => e.event === p.headlineEvent)) ||
                    p.events[0] ||
                    null;
                  return (
                    <tr
                      key={p.playerId + p.role}
                      className={`cursor-pointer border-t border-[var(--border)] transition-colors hover:bg-[color-mix(in_oklab,var(--charcoal)_75%,transparent)] ${
                        !p.applied ? "opacity-70" : ""
                      }`}
                      onClick={() => setOpenPlayerIdx(i)}
                    >
                      <td className="px-3 py-2 text-[var(--cream)]">{p.name}</td>
                      <td className="px-3 py-2 text-[var(--warm-muted)]">{p.role}</td>
                      <td className="px-3 py-2 text-[var(--warm-muted)]">
                        {p.teamAbbr ?? p.team ?? "—"}
                      </td>
                      <td className="px-3 py-2 mono text-[var(--warm-muted)]">
                        {p.recentDenominator != null
                          ? `${p.recentDenominator} ${p.role === "hitter" ? "PA" : "BF"}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 mono text-[var(--warm-muted)]">
                        {p.seasonDenominator != null
                          ? `${p.seasonDenominator}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 mono text-[var(--cream)]">
                        {headline?.event ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right mono text-[var(--warm-muted)]">
                        {fmt(headline?.baselineMean ?? null)}
                      </td>
                      <td className="px-3 py-2 text-right mono text-[var(--cream)]">
                        {fmt(headline?.formMean ?? null)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right mono ${
                          headline?.delta != null && headline.delta > 0
                            ? "text-[var(--field,#3ecf7a)]"
                            : headline?.delta != null && headline.delta < 0
                              ? "text-[var(--cardinal,#ff5e67)]"
                              : "text-[var(--warm-muted)]"
                        }`}
                      >
                        {signedFmt(headline?.delta ?? null)}
                      </td>
                      <td className="px-3 py-2 text-[var(--warm-muted)]">{p.reason}</td>
                    </tr>
                  );
                })}
                {filteredPlayers.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-6 text-center text-[var(--warm-muted)]">
                      No player outputs for this filter.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Detail modal */}
      {openPlayer ? (
        <PlayerDetailModal
          player={openPlayer}
          onClose={() => setOpenPlayerIdx(null)}
        />
      ) : null}
    </div>
  );
}

function StatCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-sm border border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] px-3 py-2">
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-[var(--warm-muted)]">
        {label}
      </div>
      <div className="mt-0.5 text-lg text-[var(--cream)]">{value}</div>
      {sub ? <div className="mt-0.5 text-[10px] text-[var(--warm-muted)]">{sub}</div> : null}
    </div>
  );
}

function MetaCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-[var(--warm-muted)]">
        {label}
      </div>
      <div className="mt-0.5 text-sm text-[var(--cream)]">{value}</div>
      {sub ? <div className="mt-0.5 mono text-[10px] text-[var(--warm-muted)]">{sub}</div> : null}
    </div>
  );
}

function PlayerDetailModal({
  player,
  onClose,
}: {
  player: ShadowPlayerRow;
  onClose: () => void;
}) {
  const fields: any[] = Array.isArray(player.formAdjustments?.fields)
    ? player.formAdjustments.fields
    : [];
  const withheld = fields.filter((f) => f?.status === "insufficient_recent_sample");
  const applied = fields.filter((f) => f?.status === "applied");
  const source = player.formAdjustments?.source ?? null;
  const sourceFetchedAt = player.formAdjustments?.sourceFetchedAt ?? null;
  const actuals = player.actuals ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 md:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-sm border border-[var(--border)] bg-[var(--ink)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="eyebrow text-[var(--primary)]">Shadow player detail</div>
            <div className="mt-1 text-lg text-[var(--cream)]">
              {player.name}{" "}
              <span className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">
                {player.role} · {player.teamAbbr ?? player.team ?? "—"}
              </span>
            </div>
            <div className="mt-1 text-xs text-[var(--warm-muted)]">{player.reason}</div>
          </div>
          <button
            onClick={onClose}
            className="rounded-sm border border-[var(--border)] px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-[var(--warm-muted)] hover:text-[var(--cream)]"
          >
            Close
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetaCell
            label="Recent sample"
            value={
              player.recentDenominator != null
                ? `${player.recentDenominator} ${player.role === "hitter" ? "PA" : "BF"}`
                : "—"
            }
          />
          <MetaCell
            label="Season denom"
            value={player.seasonDenominator != null ? String(player.seasonDenominator) : "—"}
          />
          <MetaCell label="Adjustment applied" value={player.applied ? "Yes" : "No"} />
          <MetaCell
            label="Source"
            value={source ? "Verified MLB feed" : "—"}
            sub={sourceFetchedAt ? relTime(sourceFetchedAt) : undefined}
          />
        </div>

        {/* Per-event table */}
        <div className="mt-4 overflow-x-auto rounded-sm border border-[var(--border)]">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] text-[10px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">
              <tr>
                <th className="px-3 py-2">Event</th>
                <th className="px-3 py-2 text-right">Season rate</th>
                <th className="px-3 py-2 text-right">Recent rate</th>
                <th className="px-3 py-2 text-right">Raw Δ</th>
                <th className="px-3 py-2 text-right">Cap</th>
                <th className="px-3 py-2 text-right">Applied Δ</th>
                <th className="px-3 py-2 text-right">Shrink w</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {applied.map((f) => (
                <EventRow key={f.event + "-a"} f={f} />
              ))}
              {withheld.map((f) => (
                <EventRow key={f.event + "-w"} f={f} />
              ))}
              {applied.length + withheld.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-[var(--warm-muted)]">
                    No event fields recorded for this player.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Distribution comparison */}
        <div className="mt-4">
          <div className="eyebrow text-[var(--warm-muted)]">Distribution comparison</div>
          <div className="mt-2 overflow-x-auto rounded-sm border border-[var(--border)]">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] text-[10px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">
                <tr>
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2 text-right">Baseline μ</th>
                  <th className="px-3 py-2 text-right">Shadow μ</th>
                  <th className="px-3 py-2 text-right">Δ</th>
                  <th className="px-3 py-2 text-right">P(≥1) base → shadow</th>
                  <th className="px-3 py-2 text-right">P(≥2) base → shadow</th>
                  {actuals ? <th className="px-3 py-2 text-right">Actual</th> : null}
                </tr>
              </thead>
              <tbody>
                {player.events.map((e) => {
                  const b: any = player.baselineDistributions?.[e.event] ?? {};
                  const f: any = player.formDistributions?.[e.event] ?? {};
                  const actual = actuals ? actualForEvent(actuals, e.event, player.role) : null;
                  return (
                    <tr key={e.event} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2 mono text-[var(--cream)]">{e.event}</td>
                      <td className="px-3 py-2 text-right mono text-[var(--warm-muted)]">
                        {fmt(e.baselineMean)}
                      </td>
                      <td className="px-3 py-2 text-right mono text-[var(--cream)]">
                        {fmt(e.formMean)}
                      </td>
                      <td className="px-3 py-2 text-right mono">{signedFmt(e.delta)}</td>
                      <td className="px-3 py-2 text-right mono text-[var(--warm-muted)]">
                        {pct(b?.probAtLeast1)} → {pct(f?.probAtLeast1)}
                      </td>
                      <td className="px-3 py-2 text-right mono text-[var(--warm-muted)]">
                        {pct(b?.probAtLeast2)} → {pct(f?.probAtLeast2)}
                      </td>
                      {actuals ? (
                        <td className="px-3 py-2 text-right mono text-[var(--cream)]">
                          {actual != null ? String(actual) : "—"}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {actuals ? (
            <div className="mt-2 text-[10px] uppercase tracking-[0.18em] text-[var(--warm-muted)]">
              Early evaluation — not enough history to judge model quality.
            </div>
          ) : (
            <div className="mt-2 text-[10px] uppercase tracking-[0.18em] text-[var(--warm-muted)]">
              Actuals not yet available for this game.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EventRow({ f }: { f: any }) {
  const status = String(f?.status ?? "");
  const applied = status === "applied";
  return (
    <tr className="border-t border-[var(--border)]">
      <td className="px-3 py-2 mono text-[var(--cream)]">{String(f?.event ?? "—")}</td>
      <td className="px-3 py-2 text-right mono text-[var(--warm-muted)]">
        {fmt(f?.seasonRate)}
      </td>
      <td className="px-3 py-2 text-right mono text-[var(--cream)]">
        {f?.recentRate != null ? fmt(f.recentRate) : "—"}
      </td>
      <td className="px-3 py-2 text-right mono">
        {f?.rawDelta != null ? signedFmt(f.rawDelta) : "—"}
      </td>
      <td className="px-3 py-2 text-right mono text-[var(--warm-muted)]">
        ±{fmt(f?.cap)}
      </td>
      <td className={`px-3 py-2 text-right mono ${applied ? "text-[var(--cream)]" : "text-[var(--warm-muted)]"}`}>
        {signedFmt(f?.appliedDelta)}
      </td>
      <td className="px-3 py-2 text-right mono text-[var(--warm-muted)]">
        {fmt(f?.shrinkWeight)}
      </td>
      <td className="px-3 py-2 text-[var(--warm-muted)]">
        {status.replace(/_/g, " ")}
      </td>
    </tr>
  );
}

function actualForEvent(actuals: any, event: string, role: "hitter" | "pitcher"): number | string | null {
  if (!actuals || typeof actuals !== "object") return null;
  // projection_results columns vary; try several sensible keys.
  const keyCandidates: Record<string, string[]> = {
    H: ["hits", "h"],
    HR: ["home_runs", "hr"],
    K: role === "hitter" ? ["strikeouts", "k"] : ["strikeouts", "pitcher_k", "k"],
    BB: role === "hitter" ? ["walks", "bb"] : ["walks", "pitcher_bb", "bb"],
    TB: ["total_bases", "tb"],
    R: ["runs", "r"],
    RBI: ["rbi"],
    outs: ["outs_recorded", "outs"],
    ER: ["earned_runs", "er"],
  };
  for (const k of keyCandidates[event] ?? []) {
    if (actuals[k] != null) return actuals[k];
  }
  return null;
}
