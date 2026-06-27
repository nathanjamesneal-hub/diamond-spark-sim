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

function summarizeBinary(
  key: BinaryMarketKey,
  label: string,
  group: "hitter" | "pitcher",
  pairs: { p: number; y: 0 | 1 }[],
): BinaryMarketSummary {
  let n = 0, pSum = 0, oSum = 0, brierSum = 0, llSum = 0;
  const ys: number[] = [];
  for (const { p, y } of pairs) {
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
    key, label, group, n,
    predicted_avg: n > 0 ? pSum / n : null,
    observed_rate: observed,
    delta: observed != null && n > 0 ? observed - pSum / n : null,
    brier: n > 0 ? brierSum / n : null,
    log_loss: n > 0 ? llSum / n : null,
    baseline_brier: baseBrier,
    baseline_log_loss: baseLL,
    sample_label: sample,
  };
}

export function buildBinaryMarkets(
  leaders: SimulationLeadersPayload,
  actuals: ActualsPayload,
): BinaryMarketSummary[] {
  const out: BinaryMarketSummary[] = [];
  for (const { key, label, getProb, getActual } of HITTER_BINARY) {
    const pairs: { p: number; y: 0 | 1 }[] = [];
    for (const h of leaders.hitters) {
      const p = getProb(h);
      if (p == null || !isFinite(p)) continue;
      if (h.mlb_game_id == null || !actuals.finalGames.includes(h.mlb_game_id)) continue;
      const act = h.mlb_id != null ? actuals.hitters[String(h.mlb_id)] : undefined;
      if (!act) continue;
      pairs.push({ p, y: getActual(act) >= 1 ? 1 : 0 });
    }
    out.push(summarizeBinary(key, label, "hitter", pairs));
  }
  for (const { key, label, getProb, getEvent } of PITCHER_BINARY) {
    const pairs: { p: number; y: 0 | 1 }[] = [];
    for (const pp of leaders.pitchers) {
      const p = getProb(pp);
      if (p == null || !isFinite(p)) continue;
      if (pp.mlb_game_id == null || !actuals.finalGames.includes(pp.mlb_game_id)) continue;
      const act = pp.mlb_id != null ? actuals.pitchers[String(pp.mlb_id)] : undefined;
      if (!act) continue;
      pairs.push({ p, y: getEvent(act) ? 1 : 0 });
    }
    out.push(summarizeBinary(key, label, "pitcher", pairs));
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Full Projection Audit — per-player rows joining persisted snapshot
// projections against final box-score actuals. Display-only.
// ──────────────────────────────────────────────────────────────────────

export type AuditStatKey =
  | "H" | "TB" | "HR" | "RBI" | "R" | "SB" | "K"
  | "outs" | "PK" | "BB" | "ER" | "PH";

export type AuditStatCell = {
  key: AuditStatKey;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  prob1: number | null;
  actual: number | null;
  delta: number | null;
  inP50P90: boolean | null;
};

export type AuditRow = {
  key: string;
  group: "hitter" | "pitcher";
  player_name: string;
  mlb_id: number | null;
  team_abbrev: string;
  opp_abbrev: string;
  game_id: string;
  mlb_game_id: number | null;
  diamond_score: number | null;
  lineup_spot: number | null;
  stats: Partial<Record<AuditStatKey, AuditStatCell>>;
};

const HITTER_AUDIT: { key: AuditStatKey; stat: (r: SimLeaderHitterRow) => { mean: number | null; p50: number | null; p90: number | null; probAtLeast1: number | null } | null; actual: (a: HitterActual) => number | null }[] = [
  { key: "H",   stat: (r) => r.H,   actual: (a) => a.H ?? null },
  { key: "TB",  stat: (r) => r.TB,  actual: (a) => a.TB ?? null },
  { key: "HR",  stat: (r) => r.HR,  actual: (a) => a.HR ?? null },
  { key: "RBI", stat: (r) => r.RBI, actual: (a) => a.RBI ?? null },
  { key: "R",   stat: (r) => r.R,   actual: (a) => a.R ?? null },
  { key: "SB",  stat: (r) => r.SB,  actual: (a) => a.SB ?? null },
  { key: "K",   stat: (r) => r.K,   actual: (a) => a.K ?? null },
];

const PITCHER_AUDIT: { key: AuditStatKey; stat: (r: SimLeaderPitcherRow) => { mean: number | null; p50: number | null; p90: number | null; probAtLeast1: number | null } | null; actual: (a: PitcherActual) => number | null }[] = [
  { key: "outs", stat: (r) => r.outs, actual: (a) => a.outs ?? null },
  { key: "PK",   stat: (r) => r.K,    actual: (a) => a.K ?? null },
  { key: "BB",   stat: (r) => r.BB,   actual: (a) => a.BB ?? null },
  { key: "ER",   stat: (r) => r.ER,   actual: (a) => a.ER ?? null },
  { key: "PH",   stat: (r) => r.H,    actual: (a) => a.H ?? null },
];

function cell(k: AuditStatKey, s: { mean: number | null; p50: number | null; p90: number | null; probAtLeast1: number | null } | null, actual: number | null): AuditStatCell {
  const mean = s?.mean ?? null;
  const p50 = s?.p50 ?? null;
  const p90 = s?.p90 ?? null;
  const prob1 = s?.probAtLeast1 ?? null;
  const delta = mean != null && actual != null ? actual - mean : null;
  const inP50P90 = actual != null && p50 != null && p90 != null ? actual >= p50 && actual <= p90 : null;
  return { key: k, mean, p50, p90, prob1, actual, delta, inP50P90 };
}

export function buildFullProjectionAudit(
  leaders: SimulationLeadersPayload,
  actuals: ActualsPayload,
  scope: "final" | "live_or_final" = "final",
): { hitters: AuditRow[]; pitchers: AuditRow[]; missing: { hitters: number; pitchers: number } } {
  const eligibleGames = scope === "live_or_final"
    ? new Set<number>([...actuals.finalGames, ...actuals.liveGames])
    : new Set<number>(actuals.finalGames);

  const hitters: AuditRow[] = [];
  const pitchers: AuditRow[] = [];
  let missingH = 0, missingP = 0;

  for (const h of leaders.hitters) {
    if (h.mlb_game_id == null || !eligibleGames.has(h.mlb_game_id)) continue;
    const act = h.mlb_id != null ? actuals.hitters[String(h.mlb_id)] : undefined;
    if (!act) { missingH += 1; continue; }
    const stats: Partial<Record<AuditStatKey, AuditStatCell>> = {};
    for (const def of HITTER_AUDIT) stats[def.key] = cell(def.key, def.stat(h), def.actual(act));
    hitters.push({
      key: `H:${h.mlb_id ?? h.player_name}:${h.game_id}`,
      group: "hitter",
      player_name: h.player_name, mlb_id: h.mlb_id,
      team_abbrev: h.team_abbrev, opp_abbrev: h.opp_abbrev,
      game_id: h.game_id, mlb_game_id: h.mlb_game_id,
      diamond_score: h.diamond_score, lineup_spot: h.batting_order,
      stats,
    });
  }
  for (const p of leaders.pitchers) {
    if (p.mlb_game_id == null || !eligibleGames.has(p.mlb_game_id)) continue;
    const act = p.mlb_id != null ? actuals.pitchers[String(p.mlb_id)] : undefined;
    if (!act) { missingP += 1; continue; }
    const stats: Partial<Record<AuditStatKey, AuditStatCell>> = {};
    for (const def of PITCHER_AUDIT) stats[def.key] = cell(def.key, def.stat(p), def.actual(act));
    pitchers.push({
      key: `P:${p.mlb_id ?? p.player_name}:${p.game_id}`,
      group: "pitcher",
      player_name: p.player_name, mlb_id: p.mlb_id,
      team_abbrev: p.team_abbrev, opp_abbrev: p.opp_abbrev,
      game_id: p.game_id, mlb_game_id: p.mlb_game_id,
      diamond_score: p.diamond_score, lineup_spot: null,
      stats,
    });
  }
  return { hitters, pitchers, missing: { hitters: missingH, pitchers: missingP } };
}

export function auditRowsToCsv(rows: AuditRow[], statKeys: AuditStatKey[]): string {
  const headers = ["player", "mlb_id", "team", "opp", "lineup_spot", "diamond_score"];
  for (const k of statKeys) headers.push(`${k}_mean`, `${k}_p50`, `${k}_p90`, `${k}_prob1`, `${k}_actual`, `${k}_delta`, `${k}_in_p50_p90`);
  const out: string[] = [headers.join(",")];
  for (const r of rows) {
    const base: (string | number | null)[] = [
      r.player_name, r.mlb_id ?? "", r.team_abbrev, r.opp_abbrev, r.lineup_spot ?? "", r.diamond_score ?? "",
    ];
    for (const k of statKeys) {
      const c = r.stats[k];
      base.push(
        c?.mean ?? "", c?.p50 ?? "", c?.p90 ?? "", c?.prob1 ?? "",
        c?.actual ?? "", c?.delta ?? "", c?.inP50P90 == null ? "" : (c.inP50P90 ? "Y" : "N"),
      );
    }
    out.push(base.map((v) => {
      if (v == null || v === "") return "";
      const s = typeof v === "number" ? (Math.round(v * 1000) / 1000).toString() : String(v);
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","));
  }
  return out.join("\n");
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
