/**
 * Builds Petri engine inputs from stored app data only. Derives batter and
 * pitcher per-PA rates from `player_dna` (contact/power/discipline/speed)
 * blended with league baselines. Records every source path so the run is
 * fully auditable.
 *
 * Returns null when the game cannot be simulated; reasons are recorded
 * on the caller.
 */
import { LEAGUE_RATES, type PetriBatter, type PetriPitcher, type PetriTeam, type PetriParkFactor } from "./engine";

export type DnaRow = {
  player_id: string;
  contact: number;      // 0-100
  power: number;
  discipline: number;
  speed: number;
  consistency: number;
};

export type SourceMap = Record<string, string>; // path -> origin

type Norm = (x: number | null | undefined) => number; // 0..1 around 0.5 = league avg
const norm: Norm = (x) => {
  if (x === null || x === undefined || !Number.isFinite(x)) return 0.5;
  return Math.min(1, Math.max(0, x / 100));
};

/**
 * Convert DNA to per-PA batter rates. League is the anchor; DNA nudges
 * within ±35% on each rate. This is intentionally conservative because the
 * raw rates only come from 0-100 trait scores, not full season splits.
 */
export function batterRatesFromDna(dna: DnaRow | undefined, sources: SourceMap, prefix: string): PetriBatter["rates"] {
  if (!dna) {
    sources[`${prefix}.rates`] = "fallback:league_baseline";
    return {
      K: LEAGUE_RATES.K,
      BBHBP: LEAGUE_RATES.BBHBP,
      HR: LEAGUE_RATES.HR,
      H_1B: LEAGUE_RATES.H_1B,
      H_2B: LEAGUE_RATES.H_2B,
      H_3B: LEAGUE_RATES.H_3B,
    };
  }
  sources[`${prefix}.rates`] = "player_dna";
  const contact = norm(dna.contact);
  const power = norm(dna.power);
  const discipline = norm(dna.discipline);
  const speed = norm(dna.speed);

  // High contact -> lower K, more 1B. High discipline -> more BB+HBP, less K.
  // High power -> more HR, more XBH. High speed -> small 2B/3B bump.
  const kMult = 1 + 0.35 * ((1 - contact) - 0.5) * 2 + 0.15 * ((1 - discipline) - 0.5) * 2;
  const bbMult = 1 + 0.35 * (discipline - 0.5) * 2;
  const hrMult = 1 + 0.6 * (power - 0.5) * 2;
  const h1bMult = 1 + 0.25 * (contact - 0.5) * 2;
  const h2bMult = 1 + 0.30 * (power - 0.5) * 2 + 0.10 * (speed - 0.5) * 2;
  const h3bMult = 1 + 0.45 * (speed - 0.5) * 2;

  return {
    K: clamp(LEAGUE_RATES.K * kMult, 0.05, 0.45),
    BBHBP: clamp(LEAGUE_RATES.BBHBP * bbMult, 0.03, 0.20),
    HR: clamp(LEAGUE_RATES.HR * hrMult, 0.005, 0.080),
    H_1B: clamp(LEAGUE_RATES.H_1B * h1bMult, 0.080, 0.200),
    H_2B: clamp(LEAGUE_RATES.H_2B * h2bMult, 0.020, 0.080),
    H_3B: clamp(LEAGUE_RATES.H_3B * h3bMult, 0.001, 0.012),
  };
}

/**
 * Pitcher rates are derived from DNA when present (treating pitcher DNA
 * dimensions as control/stuff proxies); otherwise league. This avoids
 * importing Alpha pitcher formulas.
 */
export function pitcherRatesFromDna(dna: DnaRow | undefined, sources: SourceMap, prefix: string): PetriPitcher["rates"] {
  if (!dna) {
    sources[`${prefix}.rates`] = "fallback:league_baseline";
    return {
      K: LEAGUE_RATES.K,
      BBHBP: LEAGUE_RATES.BBHBP,
      HR: LEAGUE_RATES.HR,
      H_1B: LEAGUE_RATES.H_1B,
      H_2B: LEAGUE_RATES.H_2B,
      H_3B: LEAGUE_RATES.H_3B,
    };
  }
  sources[`${prefix}.rates`] = "player_dna";
  // Use power dim as "stuff" (K), discipline as "command" (BB suppression).
  const stuff = norm(dna.power);
  const command = norm(dna.discipline);
  const contact = norm(dna.contact); // contact-allowed proxy when applied to pitcher
  return {
    K: clamp(LEAGUE_RATES.K * (1 + 0.40 * (stuff - 0.5) * 2), 0.10, 0.40),
    BBHBP: clamp(LEAGUE_RATES.BBHBP * (1 + 0.40 * ((1 - command) - 0.5) * 2), 0.04, 0.18),
    HR: clamp(LEAGUE_RATES.HR * (1 + 0.35 * ((1 - command) - 0.5) * 2), 0.010, 0.060),
    H_1B: clamp(LEAGUE_RATES.H_1B * (1 + 0.25 * ((1 - contact) - 0.5) * 2), 0.080, 0.200),
    H_2B: clamp(LEAGUE_RATES.H_2B * (1 + 0.20 * ((1 - contact) - 0.5) * 2), 0.020, 0.080),
    H_3B: LEAGUE_RATES.H_3B,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Park factor lookup. Returns neutral when ballpark unknown. */
export function petriParkFactor(ballpark: string | null | undefined, sources: SourceMap): PetriParkFactor {
  if (!ballpark) {
    sources["park"] = "fallback:neutral_park";
    return { hr: 100, hits: 100 };
  }
  sources["park"] = `ballpark:${ballpark}`;
  // Conservative env coefficients per ballpark name (subset).
  const factors: Record<string, PetriParkFactor> = {
    "Coors Field": { hr: 118, hits: 106 },
    "Great American Ball Park": { hr: 110, hits: 102 },
    "Yankee Stadium": { hr: 112, hits: 103 },
    "Citizens Bank Park": { hr: 105, hits: 101 },
    "Globe Life Field": { hr: 104, hits: 101 },
    "Fenway Park": { hr: 96, hits: 102 },
    "Oracle Park": { hr: 88, hits: 96 },
    "Petco Park": { hr: 90, hits: 96 },
    "loanDepot park": { hr: 88, hits: 96 },
  };
  return factors[ballpark] ?? { hr: 100, hits: 100 };
}

export type BuildTeamArgs = {
  side: "home" | "away";
  abbrev: string;
  lineupSlots: Array<{ slot: number; mlbId: number; name: string; teamMlbId: number; playerUuid: string }>;
  starter: { mlbId: number; name: string; teamMlbId: number; playerUuid: string; confirmed: boolean };
  dnaByPlayerUuid: Map<string, DnaRow>;
};

export function buildPetriTeam(args: BuildTeamArgs, sources: SourceMap): PetriTeam {
  const { side, abbrev, lineupSlots, starter, dnaByPlayerUuid } = args;
  const lineup: PetriBatter[] = lineupSlots
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((row, i) => {
      const slotPath = `${side}.lineup.${row.slot}`;
      sources[`${slotPath}.player`] = "lineups";
      const dna = dnaByPlayerUuid.get(row.playerUuid);
      const rates = batterRatesFromDna(dna, sources, slotPath);
      return {
        mlbId: row.mlbId,
        name: row.name,
        teamId: row.teamMlbId,
        lineupSlot: row.slot,
        rates,
      };
    });

  const starterDna = dnaByPlayerUuid.get(starter.playerUuid);
  sources[`${side}.starter.player`] = "starting_pitchers";
  const starterRates = pitcherRatesFromDna(starterDna, sources, `${side}.starter`);
  const bullpenRates = {
    K: LEAGUE_RATES.K,
    BBHBP: LEAGUE_RATES.BBHBP,
    HR: LEAGUE_RATES.HR,
    H_1B: LEAGUE_RATES.H_1B,
    H_2B: LEAGUE_RATES.H_2B,
    H_3B: LEAGUE_RATES.H_3B,
  };
  sources[`${side}.bullpen.rates`] = "fallback:league_baseline";

  const team: PetriTeam = {
    abbrev,
    lineup,
    starter: {
      mlbId: starter.mlbId,
      name: starter.name,
      teamId: starter.teamMlbId,
      expectedOuts: 16,
      rates: starterRates,
    },
    bullpen: {
      mlbId: -1,
      name: `${abbrev} BULLPEN`,
      teamId: starter.teamMlbId,
      expectedOuts: 27,
      rates: bullpenRates,
    },
  };
  return team;
}

export function computeCompleteness(sources: SourceMap): { score: number; breakdown: Record<string, number> } {
  let dnaHits = 0;
  let dnaTotal = 0;
  let parkOk = 0;
  let parkTotal = 1;
  for (const [k, v] of Object.entries(sources)) {
    if (k.endsWith(".rates")) {
      dnaTotal++;
      if (v === "player_dna") dnaHits++;
    }
    if (k === "park") {
      parkOk = v.startsWith("ballpark:") ? 1 : 0;
    }
  }
  const dnaScore = dnaTotal ? dnaHits / dnaTotal : 0;
  const score = Math.round((0.85 * dnaScore + 0.15 * (parkOk / parkTotal)) * 1000) / 1000;
  return { score, breakdown: { dna_coverage: dnaScore, park_known: parkOk } };
}
