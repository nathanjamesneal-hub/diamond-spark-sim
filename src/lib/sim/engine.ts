/**
 * Diamond Monte Carlo engine.
 * Pure TS. No I/O. Given two teams' batter/pitcher rates and a park,
 * simulates a full MLB game N times and returns aggregate distributions.
 *
 * Outcome model (per PA):
 *   K, BB, HBP, HR, 1B, 2B, 3B, OUT_IN_PLAY
 * blended via log5(batter_rate, pitcher_rate, league_rate), then
 * scaled by park factors for HR and hits.
 *
 * Baserunner state machine: 24 base-out states, league-average advancement.
 */
import { LEAGUE, log5, normalize, type Rates } from "./league";
import { parkFactor, type ParkFactor } from "./park-factors";

export type BatterProfile = {
  id: number;
  name: string;
  pa: number;
  K: number; BB: number; HBP: number;
  HR: number; H_1B: number; H_2B: number; H_3B: number;
  SB?: number; // for prop ref only
};
export type PitcherProfile = {
  id: number;
  name: string;
  bf: number;
  K: number; BB: number; HBP: number;
  HR: number; H_1B: number; H_2B: number; H_3B: number;
  expectedIp: number; // ~5.5 for SP, ~1 for relievers
};
export type TeamSim = {
  name: string;
  abbreviation: string;
  lineup: BatterProfile[];        // batting order, 9 batters
  starter: PitcherProfile;
  bullpen: PitcherProfile;        // aggregate bullpen
};

export type SimInput = {
  home: TeamSim;
  away: TeamSim;
  venueId?: number;
  iterations?: number;
  seed?: number;
};

export type PlayerStatDist = {
  playerId: number;
  name: string;
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  /** prob >= 0.5 (i.e. at least 1) */
  probAtLeast1: number;
  /** prob >= 1.5 (i.e. at least 2) */
  probAtLeast2: number;
};
export type BatterDist = {
  playerId: number;
  name: string;
  H: PlayerStatDist;
  HR: PlayerStatDist;
  RBI: PlayerStatDist;
  R: PlayerStatDist;
  BB: PlayerStatDist;
  K: PlayerStatDist;
  TB: PlayerStatDist;
};
export type PitcherDist = {
  playerId: number;
  name: string;
  K: PlayerStatDist;
  BB: PlayerStatDist;
  ER: PlayerStatDist;
  H: PlayerStatDist;
  outs: PlayerStatDist; // outs recorded
};

export type BatterSamples = {
  playerId: number;
  name: string;
  H: number[]; HR: number[]; RBI: number[]; R: number[];
  BB: number[]; K: number[]; TB: number[];
};
export type PitcherSamples = {
  playerId: number; name: string;
  K: number[]; BB: number[]; ER: number[]; H: number[]; outs: number[];
};

export type SimResult = {
  iterations: number;
  homeWinProb: number;
  awayWinProb: number;
  tieProb: number;
  meanHomeRuns: number;
  meanAwayRuns: number;
  meanTotal: number;
  /** fair moneyline (American) */
  fairHomeML: number;
  fairAwayML: number;
  fairTotal: number; // fair O/U line (mean rounded to .5)
  totalDist: { runs: number; pct: number }[]; // histogram for total runs
  homeRunsDist: { runs: number; pct: number }[];
  awayRunsDist: { runs: number; pct: number }[];
  homeBatters: BatterDist[];
  awayBatters: BatterDist[];
  homePitcher: PitcherDist;
  awayPitcher: PitcherDist;
  nrfi: number; // P(no run in first inning, either team)
  yrfi: number;
  /** Raw per-iteration sample arrays. Length = iterations for each field.
   *  Used by the Diamond MC adapter to compute arbitrary thresholds and
   *  percentiles without re-running the sim. */
  samples: {
    homeBatters: BatterSamples[];
    awayBatters: BatterSamples[];
    homePitcher: PitcherSamples;
    awayPitcher: PitcherSamples;
  };
};


// ---------- RNG ----------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Blending ----------

function batterRate(b: BatterProfile, k: keyof Rates): number {
  if (b.pa <= 0) return (LEAGUE as any)[k] ?? 0;
  const v: any = {
    K: b.K / b.pa, BB: b.BB / b.pa, HBP: b.HBP / b.pa,
    HR: b.HR / b.pa, H_1B: b.H_1B / b.pa, H_2B: b.H_2B / b.pa, H_3B: b.H_3B / b.pa,
    OUT: 1 - (b.K + b.BB + b.HBP + b.HR + b.H_1B + b.H_2B + b.H_3B) / b.pa,
  };
  return v[k];
}
function pitcherRate(p: PitcherProfile, k: keyof Rates): number {
  if (p.bf <= 0) return (LEAGUE as any)[k] ?? 0;
  const v: any = {
    K: p.K / p.bf, BB: p.BB / p.bf, HBP: p.HBP / p.bf,
    HR: p.HR / p.bf, H_1B: p.H_1B / p.bf, H_2B: p.H_2B / p.bf, H_3B: p.H_3B / p.bf,
    OUT: 1 - (p.K + p.BB + p.HBP + p.HR + p.H_1B + p.H_2B + p.H_3B) / p.bf,
  };
  return v[k];
}

function leagueOut(): number {
  return 1 - (LEAGUE.K + LEAGUE.BB + LEAGUE.HBP + LEAGUE.HR + LEAGUE.H_1B + LEAGUE.H_2B + LEAGUE.H_3B);
}

function paRates(b: BatterProfile, p: PitcherProfile, park: ParkFactor): Rates {
  const leagueOutR = leagueOut();
  const r: Rates = {
    K: log5(batterRate(b, "K"), pitcherRate(p, "K"), LEAGUE.K),
    BB: log5(batterRate(b, "BB"), pitcherRate(p, "BB"), LEAGUE.BB),
    HBP: log5(batterRate(b, "HBP"), pitcherRate(p, "HBP"), LEAGUE.HBP),
    HR: log5(batterRate(b, "HR"), pitcherRate(p, "HR"), LEAGUE.HR) * (park.hr / 100),
    H_1B: log5(batterRate(b, "H_1B"), pitcherRate(p, "H_1B"), LEAGUE.H_1B) * (park.hits / 100),
    H_2B: log5(batterRate(b, "H_2B"), pitcherRate(p, "H_2B"), LEAGUE.H_2B) * (park.hits / 100),
    H_3B: log5(batterRate(b, "H_3B"), pitcherRate(p, "H_3B"), LEAGUE.H_3B),
    OUT: log5(batterRate(b, "OUT"), pitcherRate(p, "OUT"), leagueOutR),
  };
  return normalize(r);
}

type Outcome = "K" | "BB" | "HBP" | "HR" | "1B" | "2B" | "3B" | "OUT";
function sample(r: Rates, rng: () => number): Outcome {
  const u = rng();
  let c = r.K; if (u < c) return "K";
  c += r.BB; if (u < c) return "BB";
  c += r.HBP; if (u < c) return "HBP";
  c += r.HR; if (u < c) return "HR";
  c += r.H_1B; if (u < c) return "1B";
  c += r.H_2B; if (u < c) return "2B";
  c += r.H_3B; if (u < c) return "3B";
  return "OUT";
}

// ---------- Half-inning state machine ----------

type Bases = [boolean, boolean, boolean]; // 1B, 2B, 3B

type PAResult = {
  runsScored: number;
  rbi: number;
  outs: number;
  endBases: Bases;
  outcome: Outcome;
  batterAdvancedToScoring?: boolean; // R for batter (when crosses plate)
  batterScored: boolean;
};

function advance(outcome: Outcome, bases: Bases, outs: number, rng: () => number): PAResult {
  let [b1, b2, b3] = bases;
  let runs = 0;
  let rbi = 0;
  let newOuts = outs;
  let batterScored = false;

  switch (outcome) {
    case "K":
      newOuts++; break;
    case "BB":
    case "HBP": {
      // Forced advance only when bases ahead are loaded
      if (b1 && b2 && b3) { runs++; rbi++; }            // run forced home
      else if (b1 && b2) { b3 = true; }                  // push to third
      else if (b1) { b2 = true; }                        // push to second
      b1 = true;
      break;
    }
    case "1B": {
      // batter to 1st. Runner on 3rd scores. Runner on 2nd scores ~60%.
      // Runner on 1st to 2nd; ~30% to 3rd.
      if (b3) { runs++; rbi++; b3 = false; }
      if (b2) {
        if (rng() < 0.6) { runs++; rbi++; }
        else { b3 = true; }
        b2 = false;
      }
      if (b1) {
        if (rng() < 0.3) { b3 = true; }
        else { b2 = true; }
        b1 = false;
      }
      b1 = true;
      break;
    }
    case "2B": {
      if (b3) { runs++; rbi++; b3 = false; }
      if (b2) { runs++; rbi++; b2 = false; }
      if (b1) {
        if (rng() < 0.4) { runs++; rbi++; }
        else { b3 = true; }
        b1 = false;
      }
      b2 = true;
      break;
    }
    case "3B": {
      if (b3) { runs++; rbi++; b3 = false; }
      if (b2) { runs++; rbi++; b2 = false; }
      if (b1) { runs++; rbi++; b1 = false; }
      b3 = true;
      break;
    }
    case "HR": {
      runs = 1 + (b1 ? 1 : 0) + (b2 ? 1 : 0) + (b3 ? 1 : 0);
      rbi = runs;
      b1 = false; b2 = false; b3 = false;
      batterScored = true;
      break;
    }
    case "OUT": {
      newOuts++;
      // sac fly / productive out if <2 outs and runner on 3rd: ~25% scores
      if (outs < 2 && b3 && rng() < 0.25) {
        runs++; rbi++; b3 = false;
      }
      // GIDP if runner on 1st, <2 outs, ~12%
      if (outs < 2 && b1 && rng() < 0.12) {
        newOuts++; b1 = false;
      }
      break;
    }
  }

  return {
    runsScored: runs,
    rbi,
    outs: newOuts,
    endBases: [b1, b2, b3],
    outcome,
    batterScored,
  };
}

// ---------- Per-batter stat accumulator ----------

type BatterAccum = {
  H: number[]; HR: number[]; RBI: number[]; R: number[];
  BB: number[]; K: number[]; TB: number[];
};
type PitcherAccum = {
  K: number[]; BB: number[]; ER: number[]; H: number[]; outs: number[];
};

function emptyBatterAccum(n: number): BatterAccum[] {
  return Array.from({ length: n }, () => ({
    H: [], HR: [], RBI: [], R: [], BB: [], K: [], TB: [],
  }));
}
function emptyPitcherAccum(): PitcherAccum {
  return { K: [], BB: [], ER: [], H: [], outs: [] };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function dist(arr: number[], name: string, playerId: number): PlayerStatDist {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length || 1;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const pAtLeast1 = arr.filter((x) => x >= 1).length / n;
  const pAtLeast2 = arr.filter((x) => x >= 2).length / n;
  return {
    playerId,
    name,
    mean,
    p10: quantile(sorted, 0.1),
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    probAtLeast1: pAtLeast1,
    probAtLeast2: pAtLeast2,
  };
}

// ---------- Probability → fair American odds ----------

function probToAmerican(p: number): number {
  if (p <= 0.0001) return 99999;
  if (p >= 0.9999) return -99999;
  if (p >= 0.5) return Math.round(-100 * (p / (1 - p)));
  return Math.round(100 * ((1 - p) / p));
}

// ---------- Main sim ----------

export function simulate(input: SimInput): SimResult {
  const iters = input.iterations ?? 2000;
  const rng = mulberry32(input.seed ?? 0xBA5EBA11);
  const park = parkFactor(input.venueId);

  const homeRunsTotals: number[] = [];
  const awayRunsTotals: number[] = [];
  let homeWins = 0, awayWins = 0, ties = 0;
  let nrfiCount = 0;

  // Pre-compute PA rate tables: 9 batters × (starter | bullpen) for each side.
  function buildRateTable(offense: TeamSim, defense: TeamSim) {
    const vsStarter = offense.lineup.map((b) => paRates(b, defense.starter, park));
    const vsBullpen = offense.lineup.map((b) => paRates(b, defense.bullpen, park));
    return { vsStarter, vsBullpen };
  }
  const homeVs = buildRateTable(input.home, input.away);
  const awayVs = buildRateTable(input.away, input.home);

  const homeBatterAcc = emptyBatterAccum(input.home.lineup.length);
  const awayBatterAcc = emptyBatterAccum(input.away.lineup.length);
  const homePitcherAcc = emptyPitcherAccum();
  const awayPitcherAcc = emptyPitcherAccum();

  function playHalfInning(
    offense: TeamSim,
    defense: TeamSim,
    rateTable: { vsStarter: Rates[]; vsBullpen: Rates[] },
    batterAcc: BatterAccum[],
    pitcherAcc: PitcherAccum,
    pitcherState: { isStarter: boolean; bfFaced: number; outsRecorded: number; runsAllowed: number; hits: number; ks: number; bbs: number },
    batterIdx: number,
    perIterRunsByBatter: number[],
    perIterHrByBatter: number[],
    perIterHitsByBatter: number[],
    perIterRbiByBatter: number[],
    perIterTbByBatter: number[],
    perIterBbByBatter: number[],
    perIterKByBatter: number[],
  ): { runs: number; nextBatter: number } {
    let outs = 0;
    let bases: Bases = [false, false, false];
    let runs = 0;
    let idx = batterIdx;

    while (outs < 3) {
      // Starter pulled if expected IP exceeded
      if (pitcherState.isStarter && pitcherState.outsRecorded >= defense.starter.expectedIp * 3) {
        pitcherState.isStarter = false;
      }
      const rates = pitcherState.isStarter ? rateTable.vsStarter[idx] : rateTable.vsBullpen[idx];
      const outcome = sample(rates, rng);
      const res = advance(outcome, bases, outs, rng);
      const newOuts = res.outs - outs;
      runs += res.runsScored;
      bases = res.endBases;
      outs = res.outs;
      if (outs > 3) outs = 3;

      // accumulate batter stats
      perIterRunsByBatter[idx] += res.batterScored ? 1 : 0;
      perIterRbiByBatter[idx] += res.rbi;
      if (outcome === "1B") { perIterHitsByBatter[idx]++; perIterTbByBatter[idx] += 1; }
      else if (outcome === "2B") { perIterHitsByBatter[idx]++; perIterTbByBatter[idx] += 2; }
      else if (outcome === "3B") { perIterHitsByBatter[idx]++; perIterTbByBatter[idx] += 3; }
      else if (outcome === "HR") {
        perIterHitsByBatter[idx]++; perIterHrByBatter[idx]++; perIterTbByBatter[idx] += 4;
        perIterRunsByBatter[idx] += 0; // batterScored already counted above? HR sets batterScored=true → already added
        // Correct: batterScored true → +1 R already, don't double
      }
      else if (outcome === "BB" || outcome === "HBP") perIterBbByBatter[idx]++;
      else if (outcome === "K") perIterKByBatter[idx]++;

      // pitcher accum (only count starter)
      if (pitcherState.isStarter) {
        pitcherState.bfFaced++;
        pitcherState.outsRecorded += newOuts;
        pitcherState.runsAllowed += res.runsScored;
        if (outcome === "1B" || outcome === "2B" || outcome === "3B" || outcome === "HR") pitcherState.hits++;
        if (outcome === "K") pitcherState.ks++;
        if (outcome === "BB") pitcherState.bbs++;
      }

      idx = (idx + 1) % offense.lineup.length;
    }
    return { runs, nextBatter: idx };
  }

  for (let it = 0; it < iters; it++) {
    let homeRuns = 0, awayRuns = 0;
    let homeBatter = 0, awayBatter = 0;
    const homePerIter = {
      R: new Array(input.home.lineup.length).fill(0),
      HR: new Array(input.home.lineup.length).fill(0),
      H: new Array(input.home.lineup.length).fill(0),
      RBI: new Array(input.home.lineup.length).fill(0),
      TB: new Array(input.home.lineup.length).fill(0),
      BB: new Array(input.home.lineup.length).fill(0),
      K: new Array(input.home.lineup.length).fill(0),
    };
    const awayPerIter = {
      R: new Array(input.away.lineup.length).fill(0),
      HR: new Array(input.away.lineup.length).fill(0),
      H: new Array(input.away.lineup.length).fill(0),
      RBI: new Array(input.away.lineup.length).fill(0),
      TB: new Array(input.away.lineup.length).fill(0),
      BB: new Array(input.away.lineup.length).fill(0),
      K: new Array(input.away.lineup.length).fill(0),
    };

    const homePitcherState = { isStarter: true, bfFaced: 0, outsRecorded: 0, runsAllowed: 0, hits: 0, ks: 0, bbs: 0 };
    const awayPitcherState = { isStarter: true, bfFaced: 0, outsRecorded: 0, runsAllowed: 0, hits: 0, ks: 0, bbs: 0 };

    let firstAwayRuns = 0, firstHomeRuns = 0;

    for (let inning = 1; inning <= 9; inning++) {
      // Top half - away bats vs home pitcher
      const top = playHalfInning(
        input.away, input.home, awayVs,
        awayBatterAcc, homePitcherAcc, homePitcherState, awayBatter,
        awayPerIter.R, awayPerIter.HR, awayPerIter.H, awayPerIter.RBI, awayPerIter.TB, awayPerIter.BB, awayPerIter.K,
      );
      awayRuns += top.runs;
      awayBatter = top.nextBatter;
      if (inning === 1) firstAwayRuns = top.runs;

      // Walk-off: bottom 9 skipped if home leads
      if (inning === 9 && homeRuns > awayRuns) break;

      // Bottom half - home bats vs away pitcher
      const bot = playHalfInning(
        input.home, input.away, homeVs,
        homeBatterAcc, awayPitcherAcc, awayPitcherState, homeBatter,
        homePerIter.R, homePerIter.HR, homePerIter.H, homePerIter.RBI, homePerIter.TB, homePerIter.BB, homePerIter.K,
      );
      homeRuns += bot.runs;
      homeBatter = bot.nextBatter;
      if (inning === 1) firstHomeRuns = bot.runs;

      // Walk-off mid bottom-9
      if (inning === 9 && homeRuns > awayRuns) break;
    }

    // Extras with ghost runner rule (simplified: start with runner on 2nd, score model still applies)
    let extraInning = 10;
    while (homeRuns === awayRuns && extraInning < 18) {
      // simplified: each half-inning, add ~0.55 runs draw — but better, just simulate
      const top = playHalfInning(input.away, input.home, awayVs,
        awayBatterAcc, homePitcherAcc, homePitcherState, awayBatter,
        awayPerIter.R, awayPerIter.HR, awayPerIter.H, awayPerIter.RBI, awayPerIter.TB, awayPerIter.BB, awayPerIter.K);
      awayRuns += top.runs;
      awayBatter = top.nextBatter;
      if (homeRuns < awayRuns) {
        const bot = playHalfInning(input.home, input.away, homeVs,
          homeBatterAcc, awayPitcherAcc, awayPitcherState, homeBatter,
          homePerIter.R, homePerIter.HR, homePerIter.H, homePerIter.RBI, homePerIter.TB, homePerIter.BB, homePerIter.K);
        homeRuns += bot.runs;
        homeBatter = bot.nextBatter;
      } else if (homeRuns === awayRuns) {
        const bot = playHalfInning(input.home, input.away, homeVs,
          homeBatterAcc, awayPitcherAcc, awayPitcherState, homeBatter,
          homePerIter.R, homePerIter.HR, homePerIter.H, homePerIter.RBI, homePerIter.TB, homePerIter.BB, homePerIter.K);
        homeRuns += bot.runs;
        homeBatter = bot.nextBatter;
      }
      extraInning++;
    }

    homeRunsTotals.push(homeRuns);
    awayRunsTotals.push(awayRuns);
    if (homeRuns > awayRuns) homeWins++;
    else if (awayRuns > homeRuns) awayWins++;
    else ties++;
    if (firstAwayRuns === 0 && firstHomeRuns === 0) nrfiCount++;

    // Push per-iter stats into accumulators
    for (let i = 0; i < input.home.lineup.length; i++) {
      homeBatterAcc[i].H.push(homePerIter.H[i]);
      homeBatterAcc[i].HR.push(homePerIter.HR[i]);
      homeBatterAcc[i].RBI.push(homePerIter.RBI[i]);
      homeBatterAcc[i].R.push(homePerIter.R[i]);
      homeBatterAcc[i].BB.push(homePerIter.BB[i]);
      homeBatterAcc[i].K.push(homePerIter.K[i]);
      homeBatterAcc[i].TB.push(homePerIter.TB[i]);
    }
    for (let i = 0; i < input.away.lineup.length; i++) {
      awayBatterAcc[i].H.push(awayPerIter.H[i]);
      awayBatterAcc[i].HR.push(awayPerIter.HR[i]);
      awayBatterAcc[i].RBI.push(awayPerIter.RBI[i]);
      awayBatterAcc[i].R.push(awayPerIter.R[i]);
      awayBatterAcc[i].BB.push(awayPerIter.BB[i]);
      awayBatterAcc[i].K.push(awayPerIter.K[i]);
      awayBatterAcc[i].TB.push(awayPerIter.TB[i]);
    }
    homePitcherAcc.K.push(homePitcherState.ks);
    homePitcherAcc.BB.push(homePitcherState.bbs);
    homePitcherAcc.ER.push(homePitcherState.runsAllowed);
    homePitcherAcc.H.push(homePitcherState.hits);
    homePitcherAcc.outs.push(homePitcherState.outsRecorded);
    awayPitcherAcc.K.push(awayPitcherState.ks);
    awayPitcherAcc.BB.push(awayPitcherState.bbs);
    awayPitcherAcc.ER.push(awayPitcherState.runsAllowed);
    awayPitcherAcc.H.push(awayPitcherState.hits);
    awayPitcherAcc.outs.push(awayPitcherState.outsRecorded);
  }

  const meanHome = homeRunsTotals.reduce((a, b) => a + b, 0) / iters;
  const meanAway = awayRunsTotals.reduce((a, b) => a + b, 0) / iters;
  const meanTotal = meanHome + meanAway;

  const homeP = homeWins / iters;
  const awayP = awayWins / iters;
  const tieP = ties / iters;

  function histogram(arr: number[]): { runs: number; pct: number }[] {
    const max = Math.min(20, Math.max(...arr));
    const counts = new Array(max + 1).fill(0);
    for (const v of arr) {
      const k = Math.min(max, v);
      counts[k]++;
    }
    return counts.map((c, i) => ({ runs: i, pct: c / arr.length }));
  }
  function totalsHist(): { runs: number; pct: number }[] {
    const totals = homeRunsTotals.map((h, i) => h + awayRunsTotals[i]);
    return histogram(totals);
  }

  function batterDist(team: TeamSim, acc: BatterAccum[]): BatterDist[] {
    return team.lineup.map((b, i) => ({
      playerId: b.id,
      name: b.name,
      H: dist(acc[i].H, "H", b.id),
      HR: dist(acc[i].HR, "HR", b.id),
      RBI: dist(acc[i].RBI, "RBI", b.id),
      R: dist(acc[i].R, "R", b.id),
      BB: dist(acc[i].BB, "BB", b.id),
      K: dist(acc[i].K, "K", b.id),
      TB: dist(acc[i].TB, "TB", b.id),
    }));
  }

  return {
    iterations: iters,
    homeWinProb: homeP,
    awayWinProb: awayP,
    tieProb: tieP,
    meanHomeRuns: meanHome,
    meanAwayRuns: meanAway,
    meanTotal,
    fairHomeML: probToAmerican(homeP / (homeP + awayP || 1)),
    fairAwayML: probToAmerican(awayP / (homeP + awayP || 1)),
    fairTotal: Math.round(meanTotal * 2) / 2,
    totalDist: totalsHist(),
    homeRunsDist: histogram(homeRunsTotals),
    awayRunsDist: histogram(awayRunsTotals),
    homeBatters: batterDist(input.home, homeBatterAcc),
    awayBatters: batterDist(input.away, awayBatterAcc),
    homePitcher: {
      playerId: input.home.starter.id,
      name: input.home.starter.name,
      K: dist(homePitcherAcc.K, "K", input.home.starter.id),
      BB: dist(homePitcherAcc.BB, "BB", input.home.starter.id),
      ER: dist(homePitcherAcc.ER, "ER", input.home.starter.id),
      H: dist(homePitcherAcc.H, "H", input.home.starter.id),
      outs: dist(homePitcherAcc.outs, "outs", input.home.starter.id),
    },
    awayPitcher: {
      playerId: input.away.starter.id,
      name: input.away.starter.name,
      K: dist(awayPitcherAcc.K, "K", input.away.starter.id),
      BB: dist(awayPitcherAcc.BB, "BB", input.away.starter.id),
      ER: dist(awayPitcherAcc.ER, "ER", input.away.starter.id),
      H: dist(awayPitcherAcc.H, "H", input.away.starter.id),
      outs: dist(awayPitcherAcc.outs, "outs", input.away.starter.id),
    },
    nrfi: nrfiCount / iters,
    yrfi: 1 - nrfiCount / iters,
    samples: {
      homeBatters: input.home.lineup.map((b, i) => ({
        playerId: b.id, name: b.name,
        H: homeBatterAcc[i].H, HR: homeBatterAcc[i].HR, RBI: homeBatterAcc[i].RBI,
        R: homeBatterAcc[i].R, BB: homeBatterAcc[i].BB, K: homeBatterAcc[i].K, TB: homeBatterAcc[i].TB,
      })),
      awayBatters: input.away.lineup.map((b, i) => ({
        playerId: b.id, name: b.name,
        H: awayBatterAcc[i].H, HR: awayBatterAcc[i].HR, RBI: awayBatterAcc[i].RBI,
        R: awayBatterAcc[i].R, BB: awayBatterAcc[i].BB, K: awayBatterAcc[i].K, TB: awayBatterAcc[i].TB,
      })),
      homePitcher: {
        playerId: input.home.starter.id, name: input.home.starter.name,
        K: homePitcherAcc.K, BB: homePitcherAcc.BB, ER: homePitcherAcc.ER, H: homePitcherAcc.H, outs: homePitcherAcc.outs,
      },
      awayPitcher: {
        playerId: input.away.starter.id, name: input.away.starter.name,
        K: awayPitcherAcc.K, BB: awayPitcherAcc.BB, ER: awayPitcherAcc.ER, H: awayPitcherAcc.H, outs: awayPitcherAcc.outs,
      },
    },
  };
}
