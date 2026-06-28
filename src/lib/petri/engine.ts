/**
 * Petri v0.2 Shadow Monte Carlo engine.
 * Seeded, pure TS, no I/O. Per-PA outcome model:
 *   K, BB+HBP, OUT-in-play, 1B, 2B, 3B, HR
 *
 * Rate blending is log5(batter, pitcher, league). Park factors nudge HR / hits.
 *
 * Inputs come from `petri/inputs.ts` — Petri owns its own engine and never
 * reaches into Alpha 0.3 simulation modules.
 */
import { mulberry32 } from "./rng";

export const LEAGUE_RATES = {
  K: 0.222,
  BBHBP: 0.096, // BB + HBP combined
  HR: 0.030,
  H_1B: 0.140,
  H_2B: 0.045,
  H_3B: 0.004,
} as const;

export type PARates = {
  K: number;
  BBHBP: number;
  HR: number;
  H_1B: number;
  H_2B: number;
  H_3B: number;
  OUT: number;
};

export type PetriBatter = {
  mlbId: number;
  name: string;
  teamId: number;
  lineupSlot: number; // 1..9
  /** 0..1 batter base rates derived from app DNA + league */
  rates: { K: number; BBHBP: number; HR: number; H_1B: number; H_2B: number; H_3B: number };
};

export type PetriPitcher = {
  mlbId: number;
  name: string;
  teamId: number;
  expectedOuts: number; // ~16 SP, ~3 bullpen aggregate
  rates: { K: number; BBHBP: number; HR: number; H_1B: number; H_2B: number; H_3B: number };
};

export type PetriTeam = {
  abbrev: string;
  lineup: PetriBatter[]; // 9
  starter: PetriPitcher;
  bullpen: PetriPitcher;
};

export type PetriParkFactor = { hr: number; hits: number }; // 100 = neutral

export type PetriSimInput = {
  home: PetriTeam;
  away: PetriTeam;
  park: PetriParkFactor;
  iterations: number;
  seed: number;
  /**
   * Optional precomputed PA outcome rates per (lineup slot × pitcher kind).
   * When supplied, the engine SKIPS its internal log5+park blend and uses
   * these rates directly. This is the path used by the Petri Skill Profile
   * feature layer so all probabilities flow from one source of truth.
   * Each inner array must be aligned with `home.lineup` / `away.lineup` order.
   */
  prebuiltRates?: {
    homeVsStarter: PARates[];
    homeVsBullpen: PARates[];
    awayVsStarter: PARates[];
    awayVsBullpen: PARates[];
  };
};


function log5(b: number, p: number, l: number): number {
  if (l <= 0 || l >= 1) return b;
  const num = (b * p) / l;
  const den = num + ((1 - b) * (1 - p)) / (1 - l);
  return den <= 0 ? l : num / den;
}

function paRates(b: PetriBatter, p: PetriPitcher, park: PetriParkFactor): PARates {
  const r: PARates = {
    K: log5(b.rates.K, p.rates.K, LEAGUE_RATES.K),
    BBHBP: log5(b.rates.BBHBP, p.rates.BBHBP, LEAGUE_RATES.BBHBP),
    HR: log5(b.rates.HR, p.rates.HR, LEAGUE_RATES.HR) * (park.hr / 100),
    H_1B: log5(b.rates.H_1B, p.rates.H_1B, LEAGUE_RATES.H_1B) * (park.hits / 100),
    H_2B: log5(b.rates.H_2B, p.rates.H_2B, LEAGUE_RATES.H_2B) * (park.hits / 100),
    H_3B: log5(b.rates.H_3B, p.rates.H_3B, LEAGUE_RATES.H_3B),
    OUT: 0,
  };
  let sum = r.K + r.BBHBP + r.HR + r.H_1B + r.H_2B + r.H_3B;
  if (sum >= 1) {
    // re-normalize and clear OUT
    for (const k of Object.keys(r) as (keyof PARates)[]) r[k] = r[k] / sum;
    r.OUT = 0;
  } else {
    r.OUT = 1 - sum;
  }
  return r;
}

type Outcome = "K" | "BBHBP" | "HR" | "1B" | "2B" | "3B" | "OUT";
function sample(r: PARates, rng: () => number): Outcome {
  const u = rng();
  let c = r.K; if (u < c) return "K";
  c += r.BBHBP; if (u < c) return "BBHBP";
  c += r.HR; if (u < c) return "HR";
  c += r.H_1B; if (u < c) return "1B";
  c += r.H_2B; if (u < c) return "2B";
  c += r.H_3B; if (u < c) return "3B";
  return "OUT";
}

type Bases = [boolean, boolean, boolean];

function applyOutcome(o: Outcome, bases: Bases, outs: number, rng: () => number): { runs: number; outs: number; bases: Bases } {
  let [b1, b2, b3] = bases;
  let runs = 0;
  let newOuts = outs;
  switch (o) {
    case "K":
      newOuts++; break;
    case "BBHBP":
      if (b1 && b2 && b3) runs++;
      else if (b1 && b2) b3 = true;
      else if (b1) b2 = true;
      b1 = true;
      break;
    case "1B":
      if (b3) { runs++; b3 = false; }
      if (b2) { if (rng() < 0.6) runs++; else b3 = true; b2 = false; }
      if (b1) { if (rng() < 0.3) b3 = true; else b2 = true; b1 = false; }
      b1 = true;
      break;
    case "2B":
      if (b3) { runs++; b3 = false; }
      if (b2) { runs++; b2 = false; }
      if (b1) { if (rng() < 0.4) runs++; else b3 = true; b1 = false; }
      b2 = true;
      break;
    case "3B":
      if (b3) { runs++; b3 = false; }
      if (b2) { runs++; b2 = false; }
      if (b1) { runs++; b1 = false; }
      b3 = true;
      break;
    case "HR":
      runs = 1 + (b1 ? 1 : 0) + (b2 ? 1 : 0) + (b3 ? 1 : 0);
      b1 = b2 = b3 = false;
      break;
    case "OUT":
      newOuts++;
      if (outs < 2 && b3 && rng() < 0.25) { runs++; b3 = false; }
      if (outs < 2 && b1 && rng() < 0.12) { newOuts++; b1 = false; }
      break;
  }
  return { runs, outs: newOuts, bases: [b1, b2, b3] };
}

type BatterAccum = { H: number; HR: number; TB: number; K: number; PA: number };
type PitcherAccum = { K: number; outs: number; BF: number };

function emptyB(): BatterAccum { return { H: 0, HR: 0, TB: 0, K: 0, PA: 0 }; }
function emptyP(): PitcherAccum { return { K: 0, outs: 0, BF: 0 }; }

export type PetriBatterDist = {
  H: number[]; HR: number[]; TB: number[]; K: number[]; PA: number[];
};
export type PetriPitcherDist = { K: number[]; outs: number[]; BF: number[] };

export type PetriSimResult = {
  iterations: number;
  homeBatters: PetriBatterDist[];
  awayBatters: PetriBatterDist[];
  homePitcher: PetriPitcherDist;
  awayPitcher: PetriPitcherDist;
};

export function simulate(input: PetriSimInput): PetriSimResult {
  const { home, away, park, iterations, seed } = input;
  const rng = mulberry32(seed);

  // Pre-build per-PA rate matrices: lineup × (starter|bullpen)
  const homeVsStarter = home.lineup.map((b) => paRates(b, away.starter, park));
  const homeVsBullpen = home.lineup.map((b) => paRates(b, away.bullpen, park));
  const awayVsStarter = away.lineup.map((b) => paRates(b, home.starter, park));
  const awayVsBullpen = away.lineup.map((b) => paRates(b, home.bullpen, park));

  const homeAccs: PetriBatterDist[] = home.lineup.map(() => ({ H: [], HR: [], TB: [], K: [], PA: [] }));
  const awayAccs: PetriBatterDist[] = away.lineup.map(() => ({ H: [], HR: [], TB: [], K: [], PA: [] }));
  const homePitchAcc: PetriPitcherDist = { K: [], outs: [], BF: [] };
  const awayPitchAcc: PetriPitcherDist = { K: [], outs: [], BF: [] };

  function half(
    offLineup: PetriBatter[],
    rates: { starter: PARates[]; bullpen: PARates[] },
    defStarter: PetriPitcher,
    batterAcc: BatterAccum[],
    pitcherAcc: PitcherAccum,
    startBatter: number,
  ): { runs: number; nextBatter: number } {
    let outs = 0;
    let bases: Bases = [false, false, false];
    let runs = 0;
    let idx = startBatter;
    while (outs < 3) {
      const usingStarter = pitcherAcc.outs < defStarter.expectedOuts;
      const r = usingStarter ? rates.starter[idx] : rates.bullpen[idx];
      const o = sample(r, rng);
      const res = applyOutcome(o, bases, outs, rng);
      const dOuts = res.outs - outs;
      runs += res.runs;
      bases = res.bases;
      outs = Math.min(3, res.outs);

      // Batter stat accumulation (per-PA)
      const ba = batterAcc[idx];
      ba.PA++;
      if (o === "K") ba.K++;
      if (o === "1B") { ba.H++; ba.TB += 1; }
      else if (o === "2B") { ba.H++; ba.TB += 2; }
      else if (o === "3B") { ba.H++; ba.TB += 3; }
      else if (o === "HR") { ba.H++; ba.HR++; ba.TB += 4; }

      // Starter pitcher stats
      if (usingStarter) {
        pitcherAcc.BF++;
        pitcherAcc.outs += dOuts;
        if (o === "K") pitcherAcc.K++;
      }
      idx = (idx + 1) % offLineup.length;
    }
    return { runs, nextBatter: idx };
  }

  for (let it = 0; it < iterations; it++) {
    let homeRuns = 0, awayRuns = 0;
    let homeBatter = 0, awayBatter = 0;
    const hBatters = homeAccs.map(() => emptyB());
    const aBatters = awayAccs.map(() => emptyB());
    const hPitcher = emptyP();
    const aPitcher = emptyP();
    // hPitcher = HOME team's pitchers (away bats vs home pitcher)
    // aPitcher = AWAY team's pitchers (home bats vs away pitcher)
    for (let inn = 1; inn <= 9; inn++) {
      const top = half(away.lineup, { starter: awayVsStarter, bullpen: awayVsBullpen }, home.starter, aBatters, hPitcher, awayBatter);
      awayRuns += top.runs; awayBatter = top.nextBatter;
      if (inn === 9 && homeRuns > awayRuns) break;
      const bot = half(home.lineup, { starter: homeVsStarter, bullpen: homeVsBullpen }, away.starter, hBatters, aPitcher, homeBatter);
      homeRuns += bot.runs; homeBatter = bot.nextBatter;
      if (inn === 9 && homeRuns > awayRuns) break;
    }
    // Extras
    let xi = 10;
    while (homeRuns === awayRuns && xi < 15) {
      const top = half(away.lineup, { starter: awayVsStarter, bullpen: awayVsBullpen }, home.starter, aBatters, hPitcher, awayBatter);
      awayRuns += top.runs; awayBatter = top.nextBatter;
      const bot = half(home.lineup, { starter: homeVsStarter, bullpen: homeVsBullpen }, away.starter, hBatters, aPitcher, homeBatter);
      homeRuns += bot.runs; homeBatter = bot.nextBatter;
      xi++;
    }

    for (let i = 0; i < hBatters.length; i++) {
      homeAccs[i].H.push(hBatters[i].H);
      homeAccs[i].HR.push(hBatters[i].HR);
      homeAccs[i].TB.push(hBatters[i].TB);
      homeAccs[i].K.push(hBatters[i].K);
      homeAccs[i].PA.push(hBatters[i].PA);
    }
    for (let i = 0; i < aBatters.length; i++) {
      awayAccs[i].H.push(aBatters[i].H);
      awayAccs[i].HR.push(aBatters[i].HR);
      awayAccs[i].TB.push(aBatters[i].TB);
      awayAccs[i].K.push(aBatters[i].K);
      awayAccs[i].PA.push(aBatters[i].PA);
    }
    homePitchAcc.K.push(hPitcher.K);
    homePitchAcc.outs.push(hPitcher.outs);
    homePitchAcc.BF.push(hPitcher.BF);
    awayPitchAcc.K.push(aPitcher.K);
    awayPitchAcc.outs.push(aPitcher.outs);
    awayPitchAcc.BF.push(aPitcher.BF);
  }

  return {
    iterations,
    homeBatters: homeAccs,
    awayBatters: awayAccs,
    homePitcher: homePitchAcc,
    awayPitcher: awayPitchAcc,
  };
}

// ---------- Summary helpers ----------

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(arr: number[]) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length || 1;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  return {
    mean,
    p10: quantile(sorted, 0.1),
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    probAtLeast1: arr.filter((x) => x >= 1).length / n,
    probAtLeast2: arr.filter((x) => x >= 2).length / n,
  };
}
