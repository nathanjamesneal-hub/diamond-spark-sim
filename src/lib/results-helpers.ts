/**
 * Results helpers — pure display aggregators built on top of existing
 * Monte Carlo + actuals payloads. No new fetches, no model math.
 *
 * Used by /results (Daily Recap) and /model (Diagnostics) to fix the
 * "1/25 HR Calls" framing and to produce binary-market scorecards.
 */
import type {
  SimulationLeadersPayload,
  SimLeaderHitterRow,
  SimLeaderPitcherRow,
} from "@/lib/sim.functions";
import type { ActualsPayload, HitterActual, PitcherActual } from "@/lib/actuals.functions";

// ──────────────────────────────────────────────────────────────────────
// Home Run Event Review
// ──────────────────────────────────────────────────────────────────────

export type HRRow = {
  key: string;
  player_name: string;
  mlb_id: number | null;
  team_abbrev: string;
  hr_mean: number | null;       // null => "Forecast data incomplete"
  hr_prob: number;              // stored pregame P(HR>=1)
  actual_hr: number;
  occurred: boolean;            // actual_hr >= 1
};

export type HRSummary = {
  forecast_count: number;
  expected_hr_total: number;    // sum of hr_prob
  actual_hr_total: number;      // sum of actual_hr
  delta: number;                // actual - expected
  avg_hr_probability: number | null;
  avg_hr_mean: number | null;   // computed only from rows with hr_mean
  rows_with_mean: number;
  rows_missing_mean: number;
  brier: number | null;
  log_loss: number | null;
  baseline_rate: number | null; // observed hit-rate in sample (naive baseline)
  baseline_brier: number | null;
  baseline_log_loss: number | null;
  sample_label: "insufficient" | "early" | "trusted";
};

function clamp(p: number, eps = 1e-6): number {
  return Math.max(eps, Math.min(1 - eps, p));
}

export function selectHRRows(
  leaders: SimulationLeadersPayload,
  actuals: ActualsPayload,
): HRRow[] {
  const rows: HRRow[] = [];
  for (const h of leaders.hitters) {
    const prob = h.card_probabilities.hr;
    if (prob == null || !isFinite(prob)) continue;
    if (h.mlb_game_id == null || !actuals.finalGames.includes(h.mlb_game_id)) continue;
    const act = h.mlb_id != null ? actuals.hitters[String(h.mlb_id)] : undefined;
    if (!act) continue;
    const actualHr = act.HR ?? 0;
    rows.push({
      key: `${h.mlb_id ?? h.player_name}:${h.game_id}`,
      player_name: h.player_name,
      mlb_id: h.mlb_id,
      team_abbrev: h.team_abbrev,
      hr_mean: h.HR?.mean ?? null,
      hr_prob: prob,
      actual_hr: actualHr,
      occurred: actualHr >= 1,
    });
  }
  rows.sort((a, b) => b.hr_prob - a.hr_prob);
  return rows;
}

export function summarizeHR(rows: HRRow[]): HRSummary {
  const n = rows.length;
  if (n === 0) {
    return {
      forecast_count: 0, expected_hr_total: 0, actual_hr_total: 0, delta: 0,
      avg_hr_probability: null, avg_hr_mean: null,
      rows_with_mean: 0, rows_missing_mean: 0,
      brier: null, log_loss: null,
      baseline_rate: null, baseline_brier: null, baseline_log_loss: null,
      sample_label: "insufficient",
    };
  }
  let probSum = 0, actualSum = 0, brierSum = 0, llSum = 0;
  let meanSum = 0, meanN = 0, missingMean = 0;
  for (const r of rows) {
    probSum += r.hr_prob;
    actualSum += r.actual_hr;
    const y = r.occurred ? 1 : 0;
    brierSum += (r.hr_prob - y) ** 2;
    const p = clamp(r.hr_prob);
    llSum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    if (r.hr_mean != null && isFinite(r.hr_mean)) { meanSum += r.hr_mean; meanN += 1; }
    else missingMean += 1;
  }
  const baseline = rows.filter((r) => r.occurred).length / n;
  const bClamp = clamp(baseline);
  let baseBrier = 0, baseLL = 0;
  for (const r of rows) {
    const y = r.occurred ? 1 : 0;
    baseBrier += (baseline - y) ** 2;
    baseLL += -(y * Math.log(bClamp) + (1 - y) * Math.log(1 - bClamp));
  }
  const sample: HRSummary["sample_label"] =
    n < 10 ? "insufficient" : n < 30 ? "early" : "trusted";
  return {
    forecast_count: n,
    expected_hr_total: probSum,
    actual_hr_total: actualSum,
    delta: actualSum - probSum,
    avg_hr_probability: probSum / n,
    avg_hr_mean: meanN > 0 ? meanSum / meanN : null,
    rows_with_mean: meanN,
    rows_missing_mean: missingMean,
    brier: brierSum / n,
    log_loss: llSum / n,
    baseline_rate: baseline,
    baseline_brier: baseBrier / n,
    baseline_log_loss: baseLL / n,
    sample_label: sample,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Binary market scorecards (Hit≥1, HR≥1, RBI≥1, SB≥1)
// ──────────────────────────────────────────────────────────────────────

export type BinaryMarketKey = "hit" | "hr" | "rbi" | "sb" | "run" | "win" | "qs";

export type BinaryMarketSummary = {
  key: BinaryMarketKey;
  label: string;
  group: "hitter" | "pitcher";
  n: number;
  predicted_avg: number | null; // mean of stored probabilities
  observed_rate: number | null; // share with stat >= 1
  delta: number | null;         // observed - predicted (probability points)
  brier: number | null;
  log_loss: number | null;
  baseline_brier: number | null;
  baseline_log_loss: number | null;
  sample_label: HRSummary["sample_label"];
};

const HITTER_BINARY: {
  key: BinaryMarketKey; label: string;
  getProb: (h: SimLeaderHitterRow) => number | null;
  getActual: (a: HitterActual) => number;
}[] = [
  { key: "hit", label: "Hit 1+",  getProb: (h) => h.card_probabilities.hit, getActual: (a) => a.H ?? 0 },
  { key: "hr",  label: "HR 1+",   getProb: (h) => h.card_probabilities.hr,  getActual: (a) => a.HR ?? 0 },
  { key: "rbi", label: "RBI 1+",  getProb: (h) => h.card_probabilities.rbi, getActual: (a) => a.RBI ?? 0 },
  { key: "run", label: "Run 1+",  getProb: (h) => h.card_probabilities.run, getActual: (a) => a.R ?? 0 },
  { key: "sb",  label: "SB 1+",   getProb: (h) => h.card_probabilities.sb,  getActual: (a) => a.SB ?? 0 },
];

const PITCHER_BINARY: {
  key: BinaryMarketKey; label: string;
  getProb: (p: SimLeaderPitcherRow) => number | null;
  getEvent: (a: PitcherActual) => boolean;
}[] = [
  { key: "win", label: "Pitcher Win", getProb: (p) => p.win_probability, getEvent: (a) => !!a.win },
  { key: "qs",  label: "Quality Start", getProb: (p) => p.quality_start_probability, getEvent: (a) => !!a.qualityStart },
];

export function buildBinaryMarkets(
  leaders: SimulationLeadersPayload,
  actuals: ActualsPayload,
): BinaryMarketSummary[] {
  return HITTER_BINARY.map(({ key, label, getProb, getActual }) => {
    let n = 0, pSum = 0, oSum = 0, brierSum = 0, llSum = 0;
    const ys: number[] = [];
    for (const h of leaders.hitters) {
      const p = getProb(h);
      if (p == null || !isFinite(p)) continue;
      if (h.mlb_game_id == null || !actuals.finalGames.includes(h.mlb_game_id)) continue;
      const act = h.mlb_id != null ? actuals.hitters[String(h.mlb_id)] : undefined;
      if (!act) continue;
      const y = getActual(act) >= 1 ? 1 : 0;
      n += 1; pSum += p; oSum += y;
      brierSum += (p - y) ** 2;
      const pc = clamp(p);
      llSum += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
      ys.push(y);
    }
    const observed = n > 0 ? oSum / n : null;
    let baseBrier: number | null = null, baseLL: number | null = null;
    if (n > 0 && observed != null) {
      const bc = clamp(observed);
      let bb = 0, bl = 0;
      for (const y of ys) { bb += (observed - y) ** 2; bl += -(y * Math.log(bc) + (1 - y) * Math.log(1 - bc)); }
      baseBrier = bb / n; baseLL = bl / n;
    }
    const sample: HRSummary["sample_label"] =
      n < 10 ? "insufficient" : n < 30 ? "early" : "trusted";
    return {
      key, label, n,
      predicted_avg: n > 0 ? pSum / n : null,
      observed_rate: observed,
      delta: observed != null && n > 0 ? observed - pSum / n : null,
      brier: n > 0 ? brierSum / n : null,
      log_loss: n > 0 ? llSum / n : null,
      baseline_brier: baseBrier,
      baseline_log_loss: baseLL,
      sample_label: sample,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────
// Best Reads / Biggest Misses — drawn from existing mean-vs-actual rows
// ──────────────────────────────────────────────────────────────────────

export type HighlightRow = {
  key: string;
  player_name: string;
  mlb_id: number | null;
  team_abbrev: string;
  opp_abbrev: string;
  category: string;
  mean: number;
  actual: number;
  diff: number; // actual - mean
};

export function buildBestAndMisses(
  leaders: SimulationLeadersPayload,
  actuals: ActualsPayload,
): { best: HighlightRow[]; worst: HighlightRow[] } {
  type Pair = { row: SimLeaderHitterRow | SimLeaderPitcherRow; group: "hitter" | "pitcher" };
  const items: HighlightRow[] = [];
  const cats: Array<{
    key: string; label: string; group: "hitter" | "pitcher";
    getStat: (r: any) => { mean: number } | null;
    getActual: (a: any) => number | null;
  }> = [
    { key: "h",    label: "Hits",    group: "hitter",  getStat: (r) => r.H,    getActual: (a: HitterActual) => a.H ?? null },
    { key: "tb",   label: "TB",      group: "hitter",  getStat: (r) => r.TB,   getActual: (a: HitterActual) => a.TB ?? null },
    { key: "rbi",  label: "RBI",     group: "hitter",  getStat: (r) => r.RBI,  getActual: (a: HitterActual) => a.RBI ?? null },
    { key: "r",    label: "Runs",    group: "hitter",  getStat: (r) => r.R,    getActual: (a: HitterActual) => a.R ?? null },
    { key: "pk",   label: "K (P)",   group: "pitcher", getStat: (r) => r.K,    getActual: (a: PitcherActual) => a.K ?? null },
    { key: "outs", label: "Outs",    group: "pitcher", getStat: (r) => r.outs, getActual: (a: PitcherActual) => a.outs ?? null },
  ];
  const sources: Pair[] = [
    ...leaders.hitters.map((r) => ({ row: r, group: "hitter" as const })),
    ...leaders.pitchers.map((r) => ({ row: r, group: "pitcher" as const })),
  ];
  for (const { row, group } of sources) {
    if (row.mlb_game_id == null || !actuals.finalGames.includes(row.mlb_game_id)) continue;
    const act = row.mlb_id != null
      ? (group === "hitter" ? actuals.hitters[String(row.mlb_id)] : actuals.pitchers[String(row.mlb_id)])
      : undefined;
    if (!act) continue;
    for (const c of cats) {
      if (c.group !== group) continue;
      const s = c.getStat(row);
      if (!s || s.mean == null || !isFinite(s.mean) || s.mean < 0.5) continue;
      const actual = c.getActual(act);
      if (actual == null) continue;
      items.push({
        key: `${c.key}:${row.mlb_id ?? row.player_name}:${row.game_id}`,
        player_name: row.player_name,
        mlb_id: row.mlb_id,
        team_abbrev: row.team_abbrev,
        opp_abbrev: row.opp_abbrev,
        category: c.label,
        mean: s.mean,
        actual,
        diff: actual - s.mean,
      });
    }
  }
  const best = [...items].sort((a, b) => b.diff - a.diff).slice(0, 8);
  const worst = [...items].sort((a, b) => a.diff - b.diff).slice(0, 8);
  return { best, worst };
}
