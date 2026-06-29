import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  getPetriCalibration,
  type PetriCalibrationPayload,
  type PetriBinaryMarket,
  type PetriContinuousMarket,
} from "@/lib/petri/calibration.functions";
import { todayInAppTz } from "@/lib/timezone";

export const Route = createFileRoute("/_authenticated/_admin/petri-results")({
  head: () => ({ meta: [{ title: "Petri Calibration · Diamond" }] }),
  component: PetriResultsPage,
});

const fmtPct = (x: number | null, d = 1) =>
  x == null || !isFinite(x) ? "—" : `${(x * 100).toFixed(d)}%`;
const fmt = (x: number | null, d = 3) =>
  x == null || !isFinite(x) ? "—" : x.toFixed(d);
const fmt2 = (x: number | null) =>
  x == null || !isFinite(x) ? "—" : x.toFixed(2);
const signed = (x: number | null) =>
  x == null || !isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;

function PetriResultsPage() {
  const [endDate, setEndDate] = useState<string>(() => todayInAppTz());
  const [days, setDays] = useState<number>(14);
  const fn = useServerFn(getPetriCalibration);
  const q = useQuery({
    queryKey: ["petri-calibration", endDate, days],
    queryFn: () => fn({ data: { endDate, days } }),
  });

  const data = q.data as PetriCalibrationPayload | undefined;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-col gap-2 border-b border-zinc-800 pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl tracking-wide">Petri Calibration</h1>
          <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
            Shadow · Admin only
          </span>
          <Link
            to="/petri"
            className="ml-auto rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            ← Back to Petri Lab
          </Link>
        </div>
        <p className="text-sm text-zinc-400">
          Graded against final MLB box scores. Only locked, projection_class=official Petri runs
          count. Today's not-yet-final games appear in "pending."
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs uppercase tracking-wide text-zinc-400">
          End date
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="mt-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <label className="flex flex-col text-xs uppercase tracking-wide text-zinc-400">
          Window (days)
          <input
            type="number"
            min={1}
            max={60}
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
            className="mt-1 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <button
          type="button"
          onClick={() => q.refetch()}
          className="rounded bg-amber-500 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-400"
        >
          Refresh
        </button>
        {q.isFetching && <span className="text-xs text-zinc-400">loading…</span>}
        {q.error && <span className="text-xs text-red-400">{(q.error as Error).message}</span>}
      </div>

      {!data ? (
        <div className="rounded border border-zinc-800 bg-zinc-950/50 p-6 text-sm text-zinc-400">
          Loading calibration…
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Range" value={`${data.startDate} → ${data.endDate}`} />
            <Stat label="Games graded" value={data.totalGamesGraded} />
            <Stat label="Games in range" value={data.totalGamesAvailable} />
            <Stat label="Pending (not final)" value={data.pendingGames} />
          </section>

          <section className="space-y-4">
            <h2 className="font-display text-lg">Hitter binary markets</h2>
            {data.hitterMarkets.map((m) => (
              <BinaryMarketCard key={m.key} market={m} />
            ))}
          </section>

          <section className="space-y-4">
            <h2 className="font-display text-lg">Pitcher continuous markets</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {data.pitcherMarkets.map((m) => (
                <ContinuousMarketCard key={m.key} market={m} />
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg">Daily breakdown</h2>
            {data.daily.length === 0 ? (
              <p className="text-sm text-zinc-400">
                Nothing graded yet for this window. Once today's locked official runs go Final,
                they'll show up here automatically.
              </p>
            ) : (
              <div className="overflow-x-auto rounded border border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-400">
                    <tr>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-right">Games</th>
                      <th className="px-3 py-2 text-right">Hitter rows</th>
                      <th className="px-3 py-2 text-right">Pitcher rows</th>
                      <th className="px-3 py-2 text-right">Hit Brier</th>
                      <th className="px-3 py-2 text-right">TB Brier</th>
                      <th className="px-3 py-2 text-right">HR Brier</th>
                      <th className="px-3 py-2 text-right">K MAE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.daily.map((d) => (
                      <tr key={d.date} className="border-t border-zinc-800">
                        <td className="px-3 py-2 text-zinc-200">{d.date}</td>
                        <td className="px-3 py-2 text-right">{d.games_graded}</td>
                        <td className="px-3 py-2 text-right">{d.hitter_rows}</td>
                        <td className="px-3 py-2 text-right">{d.pitcher_rows}</td>
                        <td className="px-3 py-2 text-right">{fmt(d.hit_brier)}</td>
                        <td className="px-3 py-2 text-right">{fmt(d.tb_brier)}</td>
                        <td className="px-3 py-2 text-right">{fmt(d.hr_brier)}</td>
                        <td className="px-3 py-2 text-right">{fmt2(d.pk_mae)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-xs text-zinc-500">{data.notes} · generated {data.generatedAt}</p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-sm text-zinc-100">{value}</div>
    </div>
  );
}

function BinaryMarketCard({ market }: { market: PetriBinaryMarket }) {
  const better =
    market.brier != null && market.baseline_brier != null
      ? market.brier < market.baseline_brier
      : null;
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-base">{market.label}</h3>
        <div className="text-xs text-zinc-400">n={market.n}</div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Stat label="Predicted avg" value={fmtPct(market.predicted_avg)} />
        <Stat label="Observed rate" value={fmtPct(market.observed_rate)} />
        <Stat label="Delta" value={signed(market.delta_pp)} />
        <Stat
          label="Brier (vs baseline)"
          value={
            market.brier == null
              ? "—"
              : `${fmt(market.brier)} ${market.baseline_brier == null ? "" : `(${fmt(market.baseline_brier)})`}${
                  better == null ? "" : better ? " ✓" : " ✗"
                }`
          }
        />
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-zinc-400">
            <tr>
              <th className="px-2 py-1 text-left">Bucket</th>
              <th className="px-2 py-1 text-right">n</th>
              <th className="px-2 py-1 text-right">Predicted</th>
              <th className="px-2 py-1 text-right">Observed</th>
              <th className="px-2 py-1 text-right">Delta</th>
              <th className="px-2 py-1 text-right">Brier</th>
            </tr>
          </thead>
          <tbody>
            {market.buckets.map((b) => (
              <tr key={b.key} className="border-t border-zinc-800/70">
                <td className="px-2 py-1 text-zinc-200">{b.label}</td>
                <td className="px-2 py-1 text-right">{b.n}</td>
                <td className="px-2 py-1 text-right">{fmtPct(b.predicted_avg)}</td>
                <td className="px-2 py-1 text-right">{fmtPct(b.observed_rate)}</td>
                <td className={`px-2 py-1 text-right ${b.delta_pp != null && b.delta_pp >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {signed(b.delta_pp)}
                </td>
                <td className="px-2 py-1 text-right">{fmt(b.brier)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ContinuousMarketCard({ market }: { market: PetriContinuousMarket }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-display text-base">{market.label}</h3>
        <div className="text-xs text-zinc-400">n={market.n}</div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Stat label="Predicted avg" value={fmt2(market.predicted_avg)} />
        <Stat label="Observed avg" value={fmt2(market.observed_avg)} />
        <Stat label="Bias (obs − pred)" value={fmt2(market.bias)} />
        <Stat label="MAE / RMSE" value={`${fmt2(market.mae)} / ${fmt2(market.rmse)}`} />
      </div>
    </div>
  );
}
