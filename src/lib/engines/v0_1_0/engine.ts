/**
 * Diamond Engine v0.1.0 — baseline hitter projection.
 *
 * Transparent, fast, deterministic. Per-hitter outputs:
 *   diamond_score (0-100), per-stat probabilities, confidence.
 *
 * Inputs are the DNA ratings, opposing starter quality, and a simple
 * matchup grade. No simulation here — the Monte Carlo engine lives
 * separately under src/lib/sim/ and registers as its own model version.
 */

export type DnaRatings = {
  contact: number; // 0-100
  power: number;
  speed: number;
  discipline: number;
  consistency: number;
};

export type EngineInput = {
  dna: DnaRatings;
  /** Opposing starter quality 0-100 (50 = league avg, higher = tougher). */
  pitcherQuality: number;
  /** Park HR factor (100 = neutral). */
  parkHr?: number;
  /** Batting order spot 1-9 (affects PA expectations). */
  battingOrder?: number;
};

export type EngineOutput = {
  diamond_score: number;
  contact_score: number;
  power_score: number;
  speed_score: number;
  pitcher_grade: number;
  matchup_grade: number;
  confidence: number;
  hit_probability: number;
  total_base_probability: number;
  hr_probability: number;
  rbi_probability: number;
  sb_probability: number;
  inputs: EngineInput;
};

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export function project(input: EngineInput): EngineOutput {
  const { dna, pitcherQuality, parkHr = 100, battingOrder = 5 } = input;
  const paFactor = Math.max(0.7, 1.2 - (battingOrder - 1) * 0.05); // ~4.6 PA leadoff → ~3.5 PA #9

  // Pitcher grade: invert so higher = better matchup for hitter.
  const matchupBoost = clamp(100 - pitcherQuality, 0, 100); // 0-100
  const matchup_grade = clamp((matchupBoost + dna.contact) / 2);

  // Component scores blend DNA with matchup.
  const contact_score = clamp(0.65 * dna.contact + 0.35 * matchupBoost);
  const power_score = clamp(0.6 * dna.power + 0.25 * matchupBoost + 0.15 * (parkHr - 100 + 50));
  const speed_score = clamp(dna.speed);
  const pitcher_grade = clamp(pitcherQuality);

  // Per-PA rates anchored to league averages, modulated by component scores.
  const baseHitRate = 0.235;
  const baseHrRate = 0.032;
  const baseSbRate = 0.005;

  const perPaHit = clamp(baseHitRate * (0.6 + contact_score / 100), 0, 0.6);
  const perPaHr = clamp(baseHrRate * (0.4 + power_score / 70), 0, 0.15);
  const perPaSb = clamp(baseSbRate * (0.3 + speed_score / 60), 0, 0.05);

  const expectedPa = 4.2 * paFactor;
  const hit_probability = 1 - Math.pow(1 - perPaHit, expectedPa);
  const hr_probability = 1 - Math.pow(1 - perPaHr, expectedPa);
  const sb_probability = 1 - Math.pow(1 - perPaSb, expectedPa);

  // Total bases >= 2 rough proxy: combine extra-base power tilt.
  const tbBase = perPaHit + perPaHr * 1.5;
  const total_base_probability = 1 - Math.pow(1 - tbBase * 0.6, expectedPa);

  // RBI >= 1 rough proxy from power + matchup.
  const rbi_probability = clamp(
    1 - Math.pow(1 - (perPaHit * 0.35 + perPaHr * 0.9), expectedPa),
    0,
    0.95,
  );

  // Diamond score: weighted blend, scaled 0-100.
  const diamond_score = clamp(
    Math.round(
      contact_score * 0.3 +
        power_score * 0.3 +
        matchup_grade * 0.25 +
        dna.consistency * 0.1 +
        speed_score * 0.05,
    ),
  );

  // Confidence: higher with consistent hitter + strong matchup signal.
  const confidence = clamp(
    Math.round(dna.consistency * 0.5 + Math.abs(matchupBoost - 50) + 25),
  );

  return {
    diamond_score,
    contact_score: Math.round(contact_score),
    power_score: Math.round(power_score),
    speed_score: Math.round(speed_score),
    pitcher_grade: Math.round(pitcher_grade),
    matchup_grade: Math.round(matchup_grade),
    confidence,
    hit_probability: round3(hit_probability),
    total_base_probability: round3(total_base_probability),
    hr_probability: round3(hr_probability),
    rbi_probability: round3(rbi_probability),
    sb_probability: round3(sb_probability),
    inputs: input,
  };
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

export const MODEL_VERSION = "0.1.0";
