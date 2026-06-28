/**
 * Petri v0.2 — Skill Profile feature layer.
 *
 * Builds a versioned `PetriSkillProfile` per hitter and pitcher BEFORE any
 * simulation runs. Features come strictly from data that exists in the app
 * (player_dna, players.bats/throws, lineups.batting_order, games.ballpark,
 * games.weather). Any requested feature that is not in the app (xwOBA,
 * xBA, xSLG, barrel%, hard-hit%, sweet-spot, K%, BB%, contact%, whiff%,
 * pitch-mix, projected workload, opponent lineup metrics, recent form) is
 * recorded as a fallback with the reason "not in app data".
 *
 * Petri then converts the profile into mutually exclusive per-PA outcome
 * rates that normalize to exactly 1:
 *   { K, BB_HBP, OUT, "1B", "2B", "3B", HR }
 *
 * Petri probabilities are produced ONLY by this feature-to-outcome model.
 * Nothing here imports Alpha 0.3, Diamond Score, Consensus, Top Props, or
 * legacy simulator code.
 */
import { LEAGUE_RATES, type PetriParkFactor, type PetriBatter, type PetriPitcher } from "./engine";
import { batterRatesFromDna, pitcherRatesFromDna, type DnaRow, type SourceMap } from "./inputs";

export const PETRI_SKILL_PROFILE_VERSION = "petri-skill-v0.2";

/** Every "advanced" feature requested by spec; each is either {value, source}
 *  or {available:false, fallback}. */
export type FeatureRecord =
  | { available: true; value: number | string; source: string }
  | { available: false; fallback: string; reason: string };

export type Fallback = { feature: string; fallback: string; reason: string; confidence_impact: "small" | "moderate" | "large" };

export type AppliedAdjustment = {
  name: string;
  applied_to: Array<"K" | "BB_HBP" | "OUT" | "1B" | "2B" | "3B" | "HR">;
  multiplier: number;
  capped_at: number; // absolute cap (e.g. 0.08 = ±8%)
  reason: string;
};

export type PAOutcomeRates = {
  K: number;
  BB_HBP: number;
  OUT: number;
  "1B": number;
  "2B": number;
  "3B": number;
  HR: number;
};

export type BaseRates = { K: number; BBHBP: number; HR: number; H_1B: number; H_2B: number; H_3B: number };

export type HitterSkillProfile = {
  role: "hitter";
  side: "home" | "away";
  mlbId: number;
  name: string;
  teamMlbId: number;
  lineupSlot: number;
  handedness: string | null;
  features: Record<string, FeatureRecord>;
  fallbacks: Fallback[];
  baseRates: BaseRates;
  /** PA outcome rates BEFORE matchup blending — exposed for explainability. */
  paStandalone: PAOutcomeRates;
  dataCompleteness: number;
  profileVersion: string;
};

export type PitcherSkillProfile = {
  role: "pitcher";
  side: "home" | "away";
  mlbId: number;
  name: string;
  teamMlbId: number;
  handedness: string | null;
  expectedOuts: number;
  features: Record<string, FeatureRecord>;
  fallbacks: Fallback[];
  baseRates: BaseRates;
  paStandalone: PAOutcomeRates;
  dataCompleteness: number;
  profileVersion: string;
};

// ---------------- Builders ----------------

const HITTER_REQUESTED_FEATURES: Array<{ key: string; impact: Fallback["confidence_impact"] }> = [
  { key: "three_year_weighted_baseline", impact: "moderate" },
  { key: "xwOBA", impact: "moderate" },
  { key: "xBA", impact: "moderate" },
  { key: "xSLG", impact: "moderate" },
  { key: "barrel_rate", impact: "moderate" },
  { key: "hard_hit_rate", impact: "moderate" },
  { key: "sweet_spot_rate", impact: "small" },
  { key: "k_pct", impact: "moderate" },
  { key: "bb_pct", impact: "moderate" },
  { key: "contact_rate", impact: "moderate" },
  { key: "whiff_rate", impact: "moderate" },
  { key: "platoon_split", impact: "small" },
  { key: "recent_form", impact: "small" },
];

const PITCHER_REQUESTED_FEATURES: Array<{ key: string; impact: Fallback["confidence_impact"] }> = [
  { key: "three_year_weighted_baseline", impact: "moderate" },
  { key: "k_bb_pct", impact: "moderate" },
  { key: "k_pct", impact: "moderate" },
  { key: "bb_pct", impact: "moderate" },
  { key: "whiff_rate", impact: "moderate" },
  { key: "xwOBA_allowed", impact: "moderate" },
  { key: "xSLG_allowed", impact: "moderate" },
  { key: "xBA_allowed", impact: "moderate" },
  { key: "barrel_rate_allowed", impact: "moderate" },
  { key: "hard_hit_rate_allowed", impact: "moderate" },
  { key: "platoon_splits", impact: "small" },
  { key: "pitch_mix", impact: "small" },
  { key: "velocity", impact: "small" },
  { key: "projected_workload", impact: "moderate" },
  { key: "pitch_count_context", impact: "small" },
  { key: "manager_hook_risk", impact: "small" },
];

function buildAvailable(
  features: Record<string, FeatureRecord>,
  key: string,
  value: number | string,
  source: string,
) {
  features[key] = { available: true, value, source };
}

function buildFallback(
  features: Record<string, FeatureRecord>,
  fallbacks: Fallback[],
  key: string,
  fallback: string,
  reason: string,
  impact: Fallback["confidence_impact"],
) {
  features[key] = { available: false, fallback, reason };
  fallbacks.push({ feature: key, fallback, reason, confidence_impact: impact });
}

/** Standalone batter PA distribution (before matchup blending). */
function batterStandalonePA(rates: BaseRates): PAOutcomeRates {
  return normalizePA({
    K: rates.K,
    BB_HBP: rates.BBHBP,
    HR: rates.HR,
    "1B": rates.H_1B,
    "2B": rates.H_2B,
    "3B": rates.H_3B,
    OUT: Math.max(0, 1 - rates.K - rates.BBHBP - rates.HR - rates.H_1B - rates.H_2B - rates.H_3B),
  });
}

export function buildHitterSkillProfile(args: {
  side: "home" | "away";
  mlbId: number;
  name: string;
  teamMlbId: number;
  lineupSlot: number;
  player: { bats?: string | null };
  opposingHand: string | null;
  dna: DnaRow | undefined;
  park: PetriParkFactor;
  ballpark: string | null;
}): HitterSkillProfile {
  const features: Record<string, FeatureRecord> = {};
  const fallbacks: Fallback[] = [];

  // Available features
  if (args.dna) {
    buildAvailable(features, "dna.contact", args.dna.contact, "player_dna.contact");
    buildAvailable(features, "dna.power", args.dna.power, "player_dna.power");
    buildAvailable(features, "dna.discipline", args.dna.discipline, "player_dna.discipline");
    buildAvailable(features, "dna.speed", args.dna.speed, "player_dna.speed");
    buildAvailable(features, "dna.consistency", args.dna.consistency, "player_dna.consistency");
  } else {
    buildFallback(features, fallbacks, "dna", "league_baseline", "player_dna row missing", "large");
  }
  buildAvailable(features, "lineup_slot", args.lineupSlot, "lineups.batting_order");
  buildAvailable(features, "handedness", args.player.bats ?? "?", "players.bats");
  buildAvailable(features, "park_hr_factor", args.park.hr, args.ballpark ? `park:${args.ballpark}` : "fallback:neutral_park");
  buildAvailable(features, "park_hits_factor", args.park.hits, args.ballpark ? `park:${args.ballpark}` : "fallback:neutral_park");

  // Advanced features not available in app — explicit fallbacks
  for (const f of HITTER_REQUESTED_FEATURES) {
    if (!features[f.key]) {
      buildFallback(features, fallbacks, f.key, "league_baseline_via_dna", "feature not in app data", f.impact);
    }
  }

  // Sources passthrough into existing DNA→rates helper, plus expose them.
  const sourcesShim: SourceMap = {};
  const baseRates = batterRatesFromDna(args.dna, sourcesShim, `${args.side}.lineup.${args.lineupSlot}`);
  const paStandalone = batterStandalonePA(baseRates);

  const dnaScore = args.dna ? 1 : 0;
  const parkScore = args.ballpark ? 1 : 0.5;
  const handScore = args.player.bats ? 1 : 0;
  const dataCompleteness = round3(0.6 * dnaScore + 0.2 * handScore + 0.2 * parkScore);

  return {
    role: "hitter",
    side: args.side,
    mlbId: args.mlbId,
    name: args.name,
    teamMlbId: args.teamMlbId,
    lineupSlot: args.lineupSlot,
    handedness: args.player.bats ?? null,
    features,
    fallbacks,
    baseRates,
    paStandalone,
    dataCompleteness,
    profileVersion: PETRI_SKILL_PROFILE_VERSION,
  };
}

export function buildPitcherSkillProfile(args: {
  side: "home" | "away";
  mlbId: number;
  name: string;
  teamMlbId: number;
  player: { throws?: string | null };
  dna: DnaRow | undefined;
  expectedOuts: number;
  park: PetriParkFactor;
  ballpark: string | null;
  opponentDnaSummary: { avg_contact: number | null; avg_power: number | null; avg_discipline: number | null; rhb_share: number | null; lhb_share: number | null };
}): PitcherSkillProfile {
  const features: Record<string, FeatureRecord> = {};
  const fallbacks: Fallback[] = [];

  if (args.dna) {
    buildAvailable(features, "dna.stuff_proxy_power", args.dna.power, "player_dna.power");
    buildAvailable(features, "dna.command_proxy_discipline", args.dna.discipline, "player_dna.discipline");
    buildAvailable(features, "dna.contact_allowed_proxy", args.dna.contact, "player_dna.contact");
  } else {
    buildFallback(features, fallbacks, "dna", "league_baseline", "player_dna row missing", "large");
  }
  buildAvailable(features, "handedness", args.player.throws ?? "?", "players.throws");
  buildAvailable(features, "expected_outs", args.expectedOuts, "fallback:league_starter_workload");
  fallbacks.push({ feature: "projected_workload", fallback: `~${args.expectedOuts} outs`, reason: "no per-start workload stored", confidence_impact: "moderate" });
  buildAvailable(features, "park_hr_factor", args.park.hr, args.ballpark ? `park:${args.ballpark}` : "fallback:neutral_park");
  buildAvailable(features, "park_hits_factor", args.park.hits, args.ballpark ? `park:${args.ballpark}` : "fallback:neutral_park");

  const opp = args.opponentDnaSummary;
  if (opp.avg_contact != null) buildAvailable(features, "opponent_lineup_contact", round3(opp.avg_contact), "aggregate(player_dna.contact)");
  else buildFallback(features, fallbacks, "opponent_lineup_contact", "league_baseline", "opponent DNA missing", "small");
  if (opp.avg_power != null) buildAvailable(features, "opponent_lineup_power", round3(opp.avg_power), "aggregate(player_dna.power)");
  else buildFallback(features, fallbacks, "opponent_lineup_power", "league_baseline", "opponent DNA missing", "small");
  if (opp.avg_discipline != null) buildAvailable(features, "opponent_lineup_discipline_proxy_for_K", round3(opp.avg_discipline), "aggregate(player_dna.discipline)");
  else buildFallback(features, fallbacks, "opponent_lineup_k_pct", "league_baseline", "opponent K% not in app data", "small");
  if (opp.rhb_share != null) buildAvailable(features, "opponent_rhb_share", round3(opp.rhb_share), "aggregate(players.bats)");

  for (const f of PITCHER_REQUESTED_FEATURES) {
    if (!features[f.key]) {
      buildFallback(features, fallbacks, f.key, "league_baseline_via_dna", "feature not in app data", f.impact);
    }
  }

  const sourcesShim: SourceMap = {};
  const baseRates = pitcherRatesFromDna(args.dna, sourcesShim, `${args.side}.starter`);
  const paStandalone = batterStandalonePA(baseRates); // same OUT-completion shape

  const dnaScore = args.dna ? 1 : 0;
  const parkScore = args.ballpark ? 1 : 0.5;
  const handScore = args.player.throws ? 1 : 0;
  const oppScore = opp.avg_contact != null && opp.avg_power != null ? 1 : 0.4;
  const dataCompleteness = round3(0.45 * dnaScore + 0.15 * handScore + 0.15 * parkScore + 0.25 * oppScore);

  return {
    role: "pitcher",
    side: args.side,
    mlbId: args.mlbId,
    name: args.name,
    teamMlbId: args.teamMlbId,
    handedness: args.player.throws ?? null,
    expectedOuts: args.expectedOuts,
    features,
    fallbacks,
    baseRates,
    paStandalone,
    dataCompleteness,
    profileVersion: PETRI_SKILL_PROFILE_VERSION,
  };
}

// ---------------- Feature → PA outcome rates ----------------

function log5(b: number, p: number, l: number): number {
  if (l <= 0 || l >= 1) return b;
  const num = (b * p) / l;
  const den = num + ((1 - b) * (1 - p)) / (1 - l);
  return den <= 0 ? l : num / den;
}

/** Caps a multiplicative adjustment to ±capPct (e.g. 0.08 = ±8%). */
function capMult(raw: number, capPct: number): number {
  const lo = 1 - capPct;
  const hi = 1 + capPct;
  return Math.min(hi, Math.max(lo, raw));
}

/**
 * Convert (hitter profile, pitcher profile, park, optional context) into the
 * final mutually exclusive PA outcome distribution. Adjustments are returned
 * for explainability and persistence on the hitter profile.
 *
 * Order of operations:
 *   1. log5 blend of batter × pitcher × league for K, BB+HBP, HR, 1B, 2B, 3B
 *   2. Park: HR × hr/100, hits (1B/2B) × hits/100   (capped at ±20%)
 *   3. Platoon: same-hand → +K (cap 5%) -HR (cap 5%); opposite-hand mirror
 *   4. Recent form: capped ±3% on K, low weight
 *   5. OUT = 1 - sum of others; renormalize if sum >= 1
 */
export function profileToOutcomeRates(args: {
  hitter: HitterSkillProfile;
  pitcher: PitcherSkillProfile;
  park: PetriParkFactor;
}): { rates: PAOutcomeRates; adjustments: AppliedAdjustment[] } {
  const adjustments: AppliedAdjustment[] = [];

  // Step 1 — log5 blend
  let K = log5(args.hitter.baseRates.K, args.pitcher.baseRates.K, LEAGUE_RATES.K);
  let BB_HBP = log5(args.hitter.baseRates.BBHBP, args.pitcher.baseRates.BBHBP, LEAGUE_RATES.BBHBP);
  let HR = log5(args.hitter.baseRates.HR, args.pitcher.baseRates.HR, LEAGUE_RATES.HR);
  let H1 = log5(args.hitter.baseRates.H_1B, args.pitcher.baseRates.H_1B, LEAGUE_RATES.H_1B);
  let H2 = log5(args.hitter.baseRates.H_2B, args.pitcher.baseRates.H_2B, LEAGUE_RATES.H_2B);
  let H3 = log5(args.hitter.baseRates.H_3B, args.pitcher.baseRates.H_3B, LEAGUE_RATES.H_3B);

  // Step 2 — park, capped ±20%
  const parkHrMult = capMult(args.park.hr / 100, 0.2);
  const parkHitsMult = capMult(args.park.hits / 100, 0.2);
  HR *= parkHrMult;
  H1 *= parkHitsMult;
  H2 *= parkHitsMult;
  adjustments.push({ name: "park_hr", applied_to: ["HR"], multiplier: parkHrMult, capped_at: 0.2, reason: "park HR factor" });
  adjustments.push({ name: "park_hits", applied_to: ["1B", "2B"], multiplier: parkHitsMult, capped_at: 0.2, reason: "park hits factor" });

  // Step 3 — platoon, capped ±5%. Use bats vs throws when both known.
  if (args.hitter.handedness && args.pitcher.handedness) {
    const same = handedSame(args.hitter.handedness, args.pitcher.handedness);
    const platoonK = capMult(same ? 1.05 : 0.97, 0.05);
    const platoonHR = capMult(same ? 0.95 : 1.04, 0.05);
    K *= platoonK;
    HR *= platoonHR;
    adjustments.push({ name: "platoon_K", applied_to: ["K"], multiplier: platoonK, capped_at: 0.05, reason: same ? "same-hand matchup" : "opposite-hand matchup" });
    adjustments.push({ name: "platoon_HR", applied_to: ["HR"], multiplier: platoonHR, capped_at: 0.05, reason: same ? "same-hand matchup" : "opposite-hand matchup" });
  } else {
    adjustments.push({ name: "platoon", applied_to: ["K", "HR"], multiplier: 1, capped_at: 0.05, reason: "handedness missing — neutral" });
  }

  // Step 4 — recent form: app has DNA consistency only; use as ±3% K cap.
  const consistency = readNumeric(args.hitter.features["dna.consistency"]);
  if (consistency != null) {
    const norm = Math.min(1, Math.max(0, consistency / 100));
    const formMult = capMult(1 + (0.5 - norm) * 0.06, 0.03); // low consistency → slight K bump
    K *= formMult;
    adjustments.push({ name: "recent_form_capped", applied_to: ["K"], multiplier: formMult, capped_at: 0.03, reason: "DNA consistency proxy, low-weight" });
  } else {
    adjustments.push({ name: "recent_form_capped", applied_to: ["K"], multiplier: 1, capped_at: 0.03, reason: "form unavailable — neutral" });
  }

  // Step 5 — assemble, enforce non-negative, then normalize to sum exactly 1.
  const raw: PAOutcomeRates = {
    K: Math.max(0, K),
    BB_HBP: Math.max(0, BB_HBP),
    HR: Math.max(0, HR),
    "1B": Math.max(0, H1),
    "2B": Math.max(0, H2),
    "3B": Math.max(0, H3),
    OUT: 0,
  };
  const sumHits = raw.K + raw.BB_HBP + raw.HR + raw["1B"] + raw["2B"] + raw["3B"];
  if (sumHits >= 1) {
    // proportionally rescale and zero OUT
    const keys: Array<keyof PAOutcomeRates> = ["K", "BB_HBP", "HR", "1B", "2B", "3B"];
    for (const k of keys) raw[k] = raw[k] / sumHits;
    raw.OUT = 0;
  } else {
    raw.OUT = 1 - sumHits;
  }
  return { rates: normalizePA(raw), adjustments };
}

function readNumeric(rec: FeatureRecord | undefined): number | null {
  if (!rec || !rec.available) return null;
  return typeof rec.value === "number" ? rec.value : null;
}

function handedSame(bats: string, throws: string): boolean {
  // Switch hitters take the opposite hand vs the pitcher — never "same".
  const b = bats.toUpperCase();
  const t = throws.toUpperCase();
  if (b === "S") return false;
  return b === t;
}

function normalizePA(r: PAOutcomeRates): PAOutcomeRates {
  const keys: Array<keyof PAOutcomeRates> = ["K", "BB_HBP", "OUT", "1B", "2B", "3B", "HR"];
  let sum = 0;
  for (const k of keys) { if (r[k] < 0) r[k] = 0; sum += r[k]; }
  if (sum <= 0) {
    // Should never happen; fall back to league baseline.
    return {
      K: LEAGUE_RATES.K, BB_HBP: LEAGUE_RATES.BBHBP, HR: LEAGUE_RATES.HR,
      "1B": LEAGUE_RATES.H_1B, "2B": LEAGUE_RATES.H_2B, "3B": LEAGUE_RATES.H_3B,
      OUT: 1 - (LEAGUE_RATES.K + LEAGUE_RATES.BBHBP + LEAGUE_RATES.HR + LEAGUE_RATES.H_1B + LEAGUE_RATES.H_2B + LEAGUE_RATES.H_3B),
    };
  }
  for (const k of keys) r[k] = r[k] / sum;
  return r;
}

/** Convert PA outcome rates into the engine's PARates shape. */
export function toEnginePARates(r: PAOutcomeRates) {
  return {
    K: r.K,
    BBHBP: r.BB_HBP,
    HR: r.HR,
    H_1B: r["1B"],
    H_2B: r["2B"],
    H_3B: r["3B"],
    OUT: r.OUT,
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Compose a `PetriBatter` (for type compatibility with engine) using the
 *  profile's base rates. The engine's per-PA blending is bypassed via
 *  `prebuiltRates`, so this is only used to carry identity into the engine. */
export function profileToBatter(p: HitterSkillProfile): PetriBatter {
  return {
    mlbId: p.mlbId,
    name: p.name,
    teamId: p.teamMlbId,
    lineupSlot: p.lineupSlot,
    rates: p.baseRates,
  };
}

export function profileToPitcher(p: PitcherSkillProfile, expectedOuts: number): PetriPitcher {
  return {
    mlbId: p.mlbId,
    name: p.name,
    teamId: p.teamMlbId,
    expectedOuts,
    rates: p.baseRates,
  };
}
