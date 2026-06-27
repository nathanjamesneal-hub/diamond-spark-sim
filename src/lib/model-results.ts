/**
 * Model Results — display-only aggregation + labeling helpers.
 *
 * Takes existing SimulationLeaders + Actuals payloads and produces per-category
 * accuracy summaries. No simulation math, no probability math, no engine logic,
 * no schema or data-fetch changes.
 *
 * Grading rules (count stats, qualified = mean >= 0.5):
 *   target = max(1, round(mean))
 *   actual >= target + 1 -> "Beat Projection"     (strong / green)
 *   actual === target    -> "Met Projection"      (good / green)
 *   actual === target-1 && actual > 0 -> "Close"  (warn / amber)
 *   actual === 0         -> "Missed"              (bad / red)
 *   otherwise lower      -> "Missed"              (bad / red)
 *
 * Rows where mean < 0.5 are tracked but excluded from Met/Beat denominator:
 *   actual === 0 -> "Low Projection / No Event" (muted / gray)
 *   actual > 0   -> "Unexpected Event"          (warn / amber)
 */
import type {
  SimLeaderHitterRow,
  SimLeaderPitcherRow,
  SimulationLeadersPayload,
  SimStat,
} from "@/lib/sim.functions";
import type {
  ActualsPayload,
  HitterActual,
  PitcherActual,
} from "@/lib/actuals.functions";

export type MRCategoryKey =
  | "hit"
  | "tb"
  | "rbi"
  | "runs"
  | "hr"
  | "sb"
  | "bk"
  | "pk"
  | "outs"
  | "bb"
  | "er"
  | "ph";

export type MRGrade =
  | "Beat Projection"
  | "Met Projection"
  | "Close"
  | "Missed"
  | "Low Projection / No Event"
  | "Unexpected Event"
  | "N/A";


export type MRTone = "strong" | "good" | "warn" | "bad" | "muted";

export type MRCategoryDef = {
  key: MRCategoryKey;
  label: string;
  group: "hitter" | "pitcher";
  meanLabel: string;
  meanDigits: number;
  getStat: (row: SimLeaderHitterRow | SimLeaderPitcherRow) => SimStat | null;
  getActual: (a: HitterActual | PitcherActual) => number | null;
};

export const MR_CATEGORIES: MRCategoryDef[] = [
  { key: "hit", label: "Hits", group: "hitter", meanLabel: "Mean H", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).H,
    getActual: (a) => (a as HitterActual).H ?? null },
  { key: "tb", label: "Total Bases", group: "hitter", meanLabel: "Mean TB", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).TB,
    getActual: (a) => (a as HitterActual).TB ?? null },
  { key: "hr", label: "Home Runs", group: "hitter", meanLabel: "Mean HR", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).HR,
    getActual: (a) => (a as HitterActual).HR ?? null },
  { key: "rbi", label: "RBI", group: "hitter", meanLabel: "Mean RBI", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).RBI,
    getActual: (a) => (a as HitterActual).RBI ?? null },
  { key: "runs", label: "Runs", group: "hitter", meanLabel: "Mean R", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).R,
    getActual: (a) => (a as HitterActual).R ?? null },
  { key: "sb", label: "Stolen Bases", group: "hitter", meanLabel: "Mean SB", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).SB,
    getActual: (a) => (a as HitterActual).SB ?? null },
  { key: "bk", label: "Batter Strikeouts", group: "hitter", meanLabel: "Mean K", meanDigits: 2,
    getStat: (r) => (r as SimLeaderHitterRow).K,
    getActual: (a) => (a as HitterActual).K ?? null },
  { key: "pk", label: "Pitcher Strikeouts", group: "pitcher", meanLabel: "Mean K", meanDigits: 1,
    getStat: (r) => (r as SimLeaderPitcherRow).K,
    getActual: (a) => (a as PitcherActual).K ?? null },
  { key: "outs", label: "Pitcher Outs", group: "pitcher", meanLabel: "Mean Outs", meanDigits: 1,
    getStat: (r) => (r as SimLeaderPitcherRow).outs,
    getActual: (a) => (a as PitcherActual).outs ?? null },
  { key: "bb", label: "Pitcher Walks", group: "pitcher", meanLabel: "Mean BB", meanDigits: 1,
    getStat: (r) => (r as SimLeaderPitcherRow).BB,
    getActual: (a) => (a as PitcherActual).BB ?? null },
  { key: "er", label: "Earned Runs", group: "pitcher", meanLabel: "Mean ER", meanDigits: 1,
    getStat: (r) => (r as SimLeaderPitcherRow).ER,
    getActual: (a) => (a as PitcherActual).ER ?? null },
  { key: "ph", label: "Pitcher Hits Allowed", group: "pitcher", meanLabel: "Mean H", meanDigits: 1,
    getStat: (r) => (r as SimLeaderPitcherRow).H,
    getActual: (a) => (a as PitcherActual).H ?? null },
];

export type MRPlayerRow = {
  key: string;
  player_name: string;
  mlb_id: number | null;
  team_abbrev: string;
  opp_abbrev: string;
  mean: number;
  target: number;
  actual: number;
  grade: MRGrade;
  tone: MRTone;
  qualified: boolean; // counted in Met/Beat denominator
};

export type MRCategorySummary = {
  cat: MRCategoryDef;
  qualified: number;
  metOrBeat: number;
  close: number;
  missed: number;
  hitRate: number | null; // (met+beat) / qualified
  avgMean: number | null;
  avgActual: number | null;
  mae: number | null;
  bias: number | null; // avg(actual - mean)
  rows: MRPlayerRow[];
  unqualifiedRows: MRPlayerRow[]; // mean < 0.5 (display-only)
};

export type MRHero = {
  qualified: number;
  metOrBeat: number;
  metOrBeatPct: number | null;
  close: number;
  missed: number;
  avgCategoryMAE: number | null; // equal-weight avg across populated categories
  hitterAvgMean: number | null;
  hitterAvgActual: number | null;
  pitcherAvgMean: number | null;
  pitcherAvgActual: number | null;
};

export type MRScope = "all" | "top25";

function gradeCount(mean: number, actual: number): { grade: MRGrade; tone: MRTone; qualified: boolean } {
  // Hard rule: a non-positive persisted Monte Carlo mean is never a success,
  // even when actual is also 0. Excluded from accuracy denominators.
  if (!isFinite(mean) || mean <= 0) {
    return { grade: "N/A", tone: "muted", qualified: false };
  }
  if (mean < 0.5) {
    if (actual === 0) return { grade: "Low Projection / No Event", tone: "muted", qualified: false };
    return { grade: "Unexpected Event", tone: "warn", qualified: false };
  }
  // qualified
  if (actual === 0) return { grade: "Missed", tone: "bad", qualified: true };
  const target = Math.max(1, Math.round(mean));
  if (actual >= target + 1) return { grade: "Beat Projection", tone: "strong", qualified: true };
  if (actual === target) return { grade: "Met Projection", tone: "good", qualified: true };
  if (actual === target - 1 && actual > 0) return { grade: "Close", tone: "warn", qualified: true };
  return { grade: "Missed", tone: "bad", qualified: true };
}


/** Top-25 selection for a category, matching /odds leaderboard ordering. */
function top25Keys(
  cat: MRCategoryDef,
  payload: SimulationLeadersPayload,
): Set<string> {
  const source: (SimLeaderHitterRow | SimLeaderPitcherRow)[] =
    cat.group === "hitter" ? payload.hitters : payload.pitchers;
  const withMean = source.filter((r) => {
    const s = cat.getStat(r);
    return s?.mean != null && isFinite(s.mean);
  });
  withMean.sort((a, b) => {
    const ma = cat.getStat(a)?.mean ?? -Infinity;
    const mb = cat.getStat(b)?.mean ?? -Infinity;
    if (mb !== ma) return mb - ma;
    return (b.diamond_score ?? -Infinity) - (a.diamond_score ?? -Infinity);
  });
  const keys = new Set<string>();
  for (const r of withMean.slice(0, 25)) {
    keys.add(`${r.mlb_id ?? r.player_name}:${r.game_id}`);
  }
  return keys;
}

export function buildCategorySummary(
  cat: MRCategoryDef,
  payload: SimulationLeadersPayload,
  actuals: ActualsPayload,
  scope: MRScope,
): MRCategorySummary {
  const source: (SimLeaderHitterRow | SimLeaderPitcherRow)[] =
    cat.group === "hitter" ? payload.hitters : payload.pitchers;
  const top = scope === "top25" ? top25Keys(cat, payload) : null;

  const rows: MRPlayerRow[] = [];
  const unq: MRPlayerRow[] = [];

  for (const r of source) {
    const key = `${r.mlb_id ?? r.player_name}:${r.game_id}`;
    if (top && !top.has(key)) continue;

    const gamePk = r.mlb_game_id;
    const isFinal = gamePk != null && actuals.finalGames.includes(gamePk);
    if (!isFinal) continue;

    const stat = cat.getStat(r);
    const mean = stat?.mean;
    if (mean == null || !isFinite(mean)) continue;

    const actualRecord =
      r.mlb_id != null
        ? cat.group === "hitter"
          ? actuals.hitters[String(r.mlb_id)]
          : actuals.pitchers[String(r.mlb_id)]
        : undefined;
    if (!actualRecord) continue;
    const actual = cat.getActual(actualRecord);
    if (actual == null) continue;

    const { grade, tone, qualified } = gradeCount(mean, actual);
    const target = Math.max(1, Math.round(mean));
    const row: MRPlayerRow = {
      key: `${cat.key}:${key}`,
      player_name: r.player_name,
      mlb_id: r.mlb_id,
      team_abbrev: r.team_abbrev,
      opp_abbrev: r.opp_abbrev,
      mean,
      target,
      actual,
      grade,
      tone,
      qualified,
    };
    if (qualified) rows.push(row);
    else unq.push(row);
  }

  let metOrBeat = 0, close = 0, missed = 0;
  let meanSum = 0, actualSum = 0, absSum = 0, biasSum = 0;
  for (const r of rows) {
    if (r.grade === "Met Projection" || r.grade === "Beat Projection") metOrBeat++;
    else if (r.grade === "Close") close++;
    else if (r.grade === "Missed") missed++;
    meanSum += r.mean;
    actualSum += r.actual;
    absSum += Math.abs(r.actual - r.mean);
    biasSum += r.actual - r.mean;
  }
  const n = rows.length;

  return {
    cat,
    qualified: n,
    metOrBeat,
    close,
    missed,
    hitRate: n > 0 ? metOrBeat / n : null,
    avgMean: n > 0 ? meanSum / n : null,
    avgActual: n > 0 ? actualSum / n : null,
    mae: n > 0 ? absSum / n : null,
    bias: n > 0 ? biasSum / n : null,
    rows: rows.sort((a, b) => b.mean - a.mean),
    unqualifiedRows: unq,
  };
}

export function buildHero(summaries: MRCategorySummary[]): MRHero {
  let qualified = 0, metOrBeat = 0, close = 0, missed = 0;
  const maes: number[] = [];

  let hSumMean = 0, hSumActual = 0, hN = 0;
  let pSumMean = 0, pSumActual = 0, pN = 0;

  for (const s of summaries) {
    qualified += s.qualified;
    metOrBeat += s.metOrBeat;
    close += s.close;
    missed += s.missed;
    if (s.mae != null) maes.push(s.mae);
    for (const r of s.rows) {
      if (s.cat.group === "hitter") {
        hSumMean += r.mean; hSumActual += r.actual; hN++;
      } else {
        pSumMean += r.mean; pSumActual += r.actual; pN++;
      }
    }
  }

  return {
    qualified,
    metOrBeat,
    metOrBeatPct: qualified > 0 ? metOrBeat / qualified : null,
    close,
    missed,
    avgCategoryMAE: maes.length > 0 ? maes.reduce((a, b) => a + b, 0) / maes.length : null,
    hitterAvgMean: hN > 0 ? hSumMean / hN : null,
    hitterAvgActual: hN > 0 ? hSumActual / hN : null,
    pitcherAvgMean: pN > 0 ? pSumMean / pN : null,
    pitcherAvgActual: pN > 0 ? pSumActual / pN : null,
  };
}

export const MR_TONE_CLASS: Record<MRTone, string> = {
  strong: "bg-emerald-500/25 text-emerald-200 border-emerald-400/50",
  good: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  bad: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  muted: "bg-zinc-500/10 text-muted-foreground border-border/40",
};
