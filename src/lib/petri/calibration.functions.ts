/**
 * Petri v0.2 Shadow Calibration — server fn.
 *
 * Aggregates LOCKED, projection_class='official' Petri runs over a date range
 * against finalized MLB box-score actuals to produce a calibration report.
 *
 * Mirrors the spirit of the Alpha /calibration page but lives entirely on
 * Petri tables and is admin-only. Petri remains shadow / not public.
 *
 * Markets graded:
 *   Binary hitter: hit_1plus (H>=1), tb_2plus (TB>=2), hr_1plus (HR>=1)
 *   Continuous pitcher: pk_mean vs actual K, outs_mean vs actual outs
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { todayInAppTz } from "@/lib/timezone";

const BUCKETS = [
  { key: "low" as const, label: "Low (<25%)", lo: 0, hi: 0.25 },
  { key: "med" as const, label: "Med (25–50%)", lo: 0.25, hi: 0.5 },
  { key: "high" as const, label: "High (≥50%)", lo: 0.5, hi: 1.01 },
];

export type PetriBinaryBucket = {
  key: "low" | "med" | "high";
  label: string;
  n: number;
  predicted_avg: number | null;
  observed_rate: number | null;
  delta_pp: number | null;
  brier: number | null;
};

export type PetriBinaryMarket = {
  key: "hit_1plus" | "tb_2plus" | "hr_1plus";
  label: string;
  n: number;
  predicted_avg: number | null;
  observed_rate: number | null;
  delta_pp: number | null;
  brier: number | null;
  log_loss: number | null;
  baseline_brier: number | null;
  baseline_log_loss: number | null;
  buckets: PetriBinaryBucket[];
};

export type PetriContinuousMarket = {
  key: "pk_mean" | "outs_mean";
  label: string;
  n: number;
  predicted_avg: number | null;
  observed_avg: number | null;
  bias: number | null; // observed - predicted
  mae: number | null;
  rmse: number | null;
};

export type PetriDailyRow = {
  date: string;
  games_graded: number;
  hitter_rows: number;
  pitcher_rows: number;
  hit_brier: number | null;
  tb_brier: number | null;
  hr_brier: number | null;
  pk_mae: number | null;
};

export type PetriCalibrationPayload = {
  generatedAt: string;
  startDate: string;
  endDate: string;
  days: number;
  totalGamesGraded: number;
  totalGamesAvailable: number; // locked official runs in range
  pendingGames: number;        // runs in range whose games aren't final yet
  hitterMarkets: PetriBinaryMarket[];
  pitcherMarkets: PetriContinuousMarket[];
  daily: PetriDailyRow[];
  notes: string;
};

function clamp(p: number, eps = 1e-6): number {
  return Math.max(eps, Math.min(1 - eps, p));
}

function addDaysISO(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function summarizeBinary(
  key: PetriBinaryMarket["key"],
  label: string,
  pairs: Array<{ p: number; y: 0 | 1 }>,
): PetriBinaryMarket {
  const n = pairs.length;
  let pSum = 0, oSum = 0, brier = 0, ll = 0;
  for (const { p, y } of pairs) {
    pSum += p; oSum += y;
    brier += (p - y) ** 2;
    const pc = clamp(p);
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  const predicted_avg = n ? pSum / n : null;
  const observed_rate = n ? oSum / n : null;
  let baseB: number | null = null, baseLL: number | null = null;
  if (n && observed_rate != null) {
    const bc = clamp(observed_rate);
    let bb = 0, bl = 0;
    for (const { y } of pairs) {
      bb += (observed_rate - y) ** 2;
      bl += -(y * Math.log(bc) + (1 - y) * Math.log(1 - bc));
    }
    baseB = bb / n;
    baseLL = bl / n;
  }
  const buckets: PetriBinaryBucket[] = BUCKETS.map((b) => {
    const sub = pairs.filter((x) => x.p >= b.lo && x.p < b.hi);
    const nn = sub.length;
    let sp = 0, so = 0, sb = 0;
    for (const { p, y } of sub) { sp += p; so += y; sb += (p - y) ** 2; }
    return {
      key: b.key, label: b.label, n: nn,
      predicted_avg: nn ? sp / nn : null,
      observed_rate: nn ? so / nn : null,
      delta_pp: nn ? (so / nn) - (sp / nn) : null,
      brier: nn ? sb / nn : null,
    };
  });
  return {
    key, label, n,
    predicted_avg, observed_rate,
    delta_pp: predicted_avg != null && observed_rate != null ? observed_rate - predicted_avg : null,
    brier: n ? brier / n : null,
    log_loss: n ? ll / n : null,
    baseline_brier: baseB,
    baseline_log_loss: baseLL,
    buckets,
  };
}

function summarizeContinuous(
  key: PetriContinuousMarket["key"],
  label: string,
  pairs: Array<{ p: number; y: number }>,
): PetriContinuousMarket {
  const n = pairs.length;
  if (!n) return { key, label, n: 0, predicted_avg: null, observed_avg: null, bias: null, mae: null, rmse: null };
  let pSum = 0, oSum = 0, ae = 0, se = 0;
  for (const { p, y } of pairs) {
    pSum += p; oSum += y;
    ae += Math.abs(p - y);
    se += (p - y) ** 2;
  }
  return {
    key, label, n,
    predicted_avg: pSum / n,
    observed_avg: oSum / n,
    bias: (oSum - pSum) / n,
    mae: ae / n,
    rmse: Math.sqrt(se / n),
  };
}

export const getPetriCalibration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { endDate?: string; days?: number } | undefined) => ({
    endDate: d?.endDate,
    days: Math.max(1, Math.min(60, d?.days ?? 14)),
  }))
  .handler(async ({ data, context }): Promise<PetriCalibrationPayload> => {
    // Admin guard (same as other Petri server fns).
    const { data: isAdmin, error: roleErr } = await (context as any).supabase.rpc("has_role", {
      _user_id: (context as any).userId, _role: "admin",
    });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getActualsForDate } = await import("@/lib/actuals.functions");

    const endDate = data.endDate ?? todayInAppTz();
    const startDate = addDaysISO(endDate, -(data.days - 1));

    // Pull LOCKED + official runs in range.
    const { data: runs, error: runsErr } = await supabaseAdmin
      .from("petri_forecast_runs")
      .select("id, game_id, mlb_game_id, game_date, status, projection_class")
      .gte("game_date", startDate)
      .lte("game_date", endDate)
      .eq("projection_class", "official")
      .eq("status", "locked");
    if (runsErr) throw new Error(runsErr.message);

    const empty: PetriCalibrationPayload = {
      generatedAt: new Date().toISOString(),
      startDate, endDate, days: data.days,
      totalGamesGraded: 0, totalGamesAvailable: 0, pendingGames: 0,
      hitterMarkets: [
        summarizeBinary("hit_1plus", "Hit 1+", []),
        summarizeBinary("tb_2plus", "Total Bases 2+", []),
        summarizeBinary("hr_1plus", "HR 1+", []),
      ],
      pitcherMarkets: [
        summarizeContinuous("pk_mean", "Pitcher K (mean)", []),
        summarizeContinuous("outs_mean", "Pitcher Outs (mean)", []),
      ],
      daily: [],
      notes: "Petri shadow calibration. Only locked official runs whose games went Final are graded.",
    };

    if (!runs?.length) return empty;
    empty.totalGamesAvailable = runs.length;

    // Group runs by date and fetch actuals per date.
    const byDate = new Map<string, any[]>();
    for (const r of runs as any[]) {
      const arr = byDate.get(r.game_date) ?? [];
      arr.push(r);
      byDate.set(r.game_date, arr);
    }

    type Pair = { p: number; y: 0 | 1 };
    type CPair = { p: number; y: number };
    const hitPairs: Pair[] = [], tbPairs: Pair[] = [], hrPairs: Pair[] = [];
    const pkPairs: CPair[] = [], outsPairs: CPair[] = [];
    const daily: PetriDailyRow[] = [];
    let totalGraded = 0, totalPending = 0;

    // Sort dates ascending; we present daily list newest-first at the end.
    const sortedDates = Array.from(byDate.keys()).sort();

    for (const date of sortedDates) {
      const dateRuns = byDate.get(date)!;
      let actuals: Awaited<ReturnType<typeof getActualsForDate>> | null = null;
      try {
        actuals = await getActualsForDate({ data: { date } });
      } catch (e) {
        console.warn("[petri.calibration] actuals failed", date, (e as Error).message);
        continue;
      }
      const finalSet = new Set(actuals.finalGames);
      const gradedRuns = dateRuns.filter((r) => finalSet.has(r.mlb_game_id));
      const pendingForDate = dateRuns.filter((r) => !finalSet.has(r.mlb_game_id));
      totalPending += pendingForDate.length;
      if (!gradedRuns.length) continue;
      totalGraded += gradedRuns.length;

      const runIds = gradedRuns.map((r) => r.id);
      const { data: snaps } = await supabaseAdmin
        .from("petri_player_market_snapshots")
        .select("role, mlb_player_id, hit_1plus, tb_2plus, hr_1plus, pk_mean, outs_mean")
        .in("run_id", runIds);

      const dayHit: Pair[] = [], dayTb: Pair[] = [], dayHr: Pair[] = [];
      const dayPk: CPair[] = [];
      let hRows = 0, pRows = 0;
      for (const s of snaps ?? []) {
        const mlbId = Number((s as any).mlb_player_id);
        if (!mlbId) continue;
        if ((s as any).role === "hitter") {
          const act = actuals.hitters[String(mlbId)];
          if (!act) continue;
          hRows += 1;
          const hp = Number((s as any).hit_1plus ?? 0);
          const tp = Number((s as any).tb_2plus ?? 0);
          const hr = Number((s as any).hr_1plus ?? 0);
          if (isFinite(hp)) dayHit.push({ p: hp, y: act.H >= 1 ? 1 : 0 });
          if (isFinite(tp)) dayTb.push({ p: tp, y: act.TB >= 2 ? 1 : 0 });
          if (isFinite(hr)) dayHr.push({ p: hr, y: act.HR >= 1 ? 1 : 0 });
        } else if ((s as any).role === "pitcher") {
          const act = actuals.pitchers[String(mlbId)];
          if (!act) continue;
          pRows += 1;
          const pk = Number((s as any).pk_mean ?? 0);
          const ou = Number((s as any).outs_mean ?? 0);
          if (isFinite(pk)) { dayPk.push({ p: pk, y: act.K }); pkPairs.push({ p: pk, y: act.K }); }
          if (isFinite(ou)) { outsPairs.push({ p: ou, y: act.outs }); }
        }
      }
      hitPairs.push(...dayHit); tbPairs.push(...dayTb); hrPairs.push(...dayHr);

      const brier = (pairs: Pair[]) =>
        pairs.length ? pairs.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / pairs.length : null;
      const mae = (pairs: CPair[]) =>
        pairs.length ? pairs.reduce((s, x) => s + Math.abs(x.p - x.y), 0) / pairs.length : null;

      daily.push({
        date,
        games_graded: gradedRuns.length,
        hitter_rows: hRows,
        pitcher_rows: pRows,
        hit_brier: brier(dayHit),
        tb_brier: brier(dayTb),
        hr_brier: brier(dayHr),
        pk_mae: mae(dayPk),
      });
    }

    daily.sort((a, b) => (a.date < b.date ? 1 : -1));

    return {
      generatedAt: new Date().toISOString(),
      startDate, endDate, days: data.days,
      totalGamesGraded: totalGraded,
      totalGamesAvailable: runs.length,
      pendingGames: totalPending,
      hitterMarkets: [
        summarizeBinary("hit_1plus", "Hit 1+", hitPairs),
        summarizeBinary("tb_2plus", "Total Bases 2+", tbPairs),
        summarizeBinary("hr_1plus", "HR 1+", hrPairs),
      ],
      pitcherMarkets: [
        summarizeContinuous("pk_mean", "Pitcher K (mean)", pkPairs),
        summarizeContinuous("outs_mean", "Pitcher Outs (mean)", outsPairs),
      ],
      daily,
      notes: "Petri shadow calibration · locked official runs only · graded vs Final MLB box scores",
    };
  });
