/**
 * Diamond MC Candidate — production simulation adapter.
 *
 * Bridges the durable sim queue to the real Monte Carlo engine in
 * `src/lib/sim/engine.ts` (per-PA sampling with log5 blend, park factors,
 * and a 24-state baserunner state machine). Replaces the placeholder
 * `simulateChunkPlaceholder` used by the worker.
 *
 * Contract:
 *   - `loadDiamondRoster(admin, job)` — reads lineups, starters, player_dna,
 *     games, and builds a per-game SimInput plus per-player metadata.
 *   - `simulateDiamondChunk(job, chunkIndex, roster, state)` — runs one
 *     chunk of real MC iterations with a deterministic per-chunk seed and
 *     merges results into the aggregator state (sum, hits, n, histogram).
 *
 * Correlation structure:
 *   - Batter outcomes ARE correlated inside a game via the shared baserunner
 *     state (RBI, R, TB, H, HR co-move iteration-to-iteration).
 *   - Pitcher outcomes for one starter ARE correlated with the opposing
 *     lineup's outcomes (same PAs drive both sides of the ledger).
 *   - Games across iterations are independent. Games across different jobs
 *     are independent.
 *   - No cross-game correlation (park/weather is shared but game outcomes are
 *     sampled independently). Documented, not fabricated.
 *
 * Engine tag: `diamond_mc_candidate` — a new status distinct from the old
 * `scaffold_unvalidated` placeholder rows and from `validated`. Prop Board
 * shows these in the Preview tier. NEVER promoted to validated by this
 * adapter; promotion requires documented calibration evidence.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { simulate, type BatterProfile, type PitcherProfile, type SimInput, type TeamSim } from "./engine.ts";
import { LEAGUE } from "./league.ts";

export const DIAMOND_ADAPTER_VERSION = "diamond-mc-candidate-0.1";
export const DIAMOND_ENGINE_STATUS = "diamond_mc_candidate";

// Reference PA counts for building rate profiles from DNA.
const BATTER_PA_REF = 600;
const STARTER_BF_REF = 700;
const BULLPEN_BF_REF = 500;

// ─── Types ────────────────────────────────────────────────────────────────

export type DiamondPlayerMeta = {
  playerId: string;              // UUID from players.id
  playerType: "bat" | "pit";
  teamId: string | null;
  opponentTeamId: string | null;
  battingOrder: number | null;
  handedness: string | null;     // bats for hitters, throws for pitchers
  oppHandedness: string | null;
  side: "home" | "away";
  syntheticId: number;           // integer id passed into engine BatterProfile.id
};

export type DiamondMarket = { market: string; threshold: number | null; stat: string; playerType: "bat" | "pit" };

export const DIAMOND_MARKETS: DiamondMarket[] = [
  { market: "1plus_hit", threshold: null, stat: "H", playerType: "bat" },
  { market: "2plus_hits", threshold: null, stat: "H", playerType: "bat" },
  { market: "total_bases", threshold: 1.5, stat: "TB", playerType: "bat" },
  { market: "hr", threshold: null, stat: "HR", playerType: "bat" },
  { market: "rbi", threshold: 0.5, stat: "RBI", playerType: "bat" },
  { market: "runs_scored", threshold: 0.5, stat: "R", playerType: "bat" },
  { market: "k", threshold: 5.5, stat: "K", playerType: "pit" },
  { market: "outs", threshold: 15.5, stat: "outs", playerType: "pit" },
  { market: "er", threshold: 2.5, stat: "ER", playerType: "pit" },
];

export type DiamondRoster = {
  simInput: SimInput;
  meta: DiamondPlayerMeta[];       // one entry per (side, player)
  venueId: number | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
};

export type AggState = Map<string, {
  market: string;
  threshold: number | null;
  hits: number;              // count of iterations crossing threshold OR >=1
  sum: number;               // sum of samples
  n: number;                 // total iterations
  playerType: "bat" | "pit";
  teamId: string | null;
  oppTeamId: string | null;
  battingOrder: number | null;
  handedness: string | null;
  hist: number[];            // hist[i] = count of iters with value=i, size 32
}>;

export type ChunkDelta = Array<{
  player_id: string; market: string; threshold: number | null;
  sum: number; hits: number; n: number;
  hist: number[]; playerType: "bat" | "pit";
  teamId: string | null; oppTeamId: string | null;
  battingOrder: number | null; handedness: string | null;
}>;

// ─── DNA → rate profile ───────────────────────────────────────────────────

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

/** Map 0-100 DNA ratings to a BatterProfile whose rates blend cleanly with league via log5. */
export function batterProfileFromDna(
  syntheticId: number,
  name: string,
  dna: { contact: number; power: number; speed: number; discipline: number } | null,
): BatterProfile {
  const contact = dna?.contact ?? 50;
  const power = dna?.power ?? 50;
  const speed = dna?.speed ?? 50;
  const disc = dna?.discipline ?? 50;

  // Rate multipliers around league averages. Bounded so tails don't explode.
  const kRate = clamp01(LEAGUE.K * (1.4 - 0.8 * (contact / 100)));
  const bbRate = clamp01(LEAGUE.BB * (0.55 + 0.9 * (disc / 100)));
  const hrRate = clamp01(LEAGUE.HR * (0.4 + 1.2 * (power / 100)));
  const h1bRate = clamp01(LEAGUE.H_1B * (0.7 + 0.6 * (contact / 100)));
  const h2bRate = clamp01(LEAGUE.H_2B * (0.6 + 0.5 * (power / 100) + 0.2 * (contact / 100)));
  const h3bRate = clamp01(LEAGUE.H_3B * (0.5 + 0.8 * (speed / 100)));

  const pa = BATTER_PA_REF;
  return {
    id: syntheticId,
    name,
    pa,
    K: Math.round(kRate * pa),
    BB: Math.round(bbRate * pa),
    HBP: Math.round(LEAGUE.HBP * pa),
    HR: Math.round(hrRate * pa),
    H_1B: Math.round(h1bRate * pa),
    H_2B: Math.round(h2bRate * pa),
    H_3B: Math.round(h3bRate * pa),
  };
}

/** Neutral league-average pitcher, with a tiny deterministic variation seeded on player id. */
export function neutralPitcherProfile(syntheticId: number, name: string, bf: number, expectedIp: number): PitcherProfile {
  // Deterministic jitter in [-0.1, +0.1] on the K rate, seeded on id.
  const h = createHash("sha256").update(`pitcher:${syntheticId}`).digest();
  const j = ((h.readUInt32BE(0) / 0xffffffff) - 0.5) * 0.2;
  const kRate = clamp01(LEAGUE.K * (1 + j));
  const bbRate = clamp01(LEAGUE.BB * (1 - j * 0.5));
  return {
    id: syntheticId, name, bf,
    K: Math.round(kRate * bf),
    BB: Math.round(bbRate * bf),
    HBP: Math.round(LEAGUE.HBP * bf),
    HR: Math.round(LEAGUE.HR * bf),
    H_1B: Math.round(LEAGUE.H_1B * bf),
    H_2B: Math.round(LEAGUE.H_2B * bf),
    H_3B: Math.round(LEAGUE.H_3B * bf),
    expectedIp,
  };
}

// ─── Roster loading ───────────────────────────────────────────────────────

function syntheticIdFor(uuid: string): number {
  // Map uuid → deterministic 31-bit int for the engine's integer id contract.
  const h = createHash("sha256").update(uuid).digest();
  return h.readUInt32BE(0) & 0x7fffffff;
}

const VENUE_MAP: Record<string, number> = {
  // Best-effort ballpark-name → mlb venue id map used by park-factors.
  "Coors Field": 15, "Great American Ball Park": 10, "Yankee Stadium": 31,
  "Fenway Park": 2, "Oracle Park": 19, "Petco Park": 22, "Wrigley Field": 17,
  "Truist Park": 3289, "loanDepot park": 4705, "Oriole Park at Camden Yards": 5,
  "Citizens Bank Park": 9, "Comerica Park": 12, "Minute Maid Park": 13,
  "Kauffman Stadium": 14, "Dodger Stadium": 16, "Citi Field": 18,
  "Rogers Centre": 4, "T-Mobile Park": 680, "Globe Life Field": 2602,
  "Nationals Park": 3312, "PNC Park": 3313,
};

type SimJobLike = {
  id: string; game_id: string; game_pk: number; slate_date: string;
  model_version: string; inputs_hash: string; tier: "2k" | "20k";
  label: string; sim_count: number; chunk_size: number; chunks_total: number;
  seed: string | null; projection_stage: string | null;
};

export async function loadDiamondRoster(admin: SupabaseClient, job: SimJobLike): Promise<DiamondRoster> {
  const [gameRes, lineupRes, starterRes] = await Promise.all([
    admin.from("games").select("id, home_team_id, away_team_id, ballpark").eq("id", job.game_id).maybeSingle(),
    admin.from("lineups").select("game_id, team_id, player_id, batting_order").eq("game_id", job.game_id),
    admin.from("starting_pitchers").select("game_id, team_id, player_id").eq("game_id", job.game_id),
  ]);
  const g = gameRes.data;
  if (!g) throw new Error(`diamond-adapter: game ${job.game_id} not found`);
  const homeId = g.home_team_id as string;
  const awayId = g.away_team_id as string;

  const lineups = (lineupRes.data ?? []) as Array<{ team_id: string; player_id: string; batting_order: number | null }>;
  const starters = (starterRes.data ?? []) as Array<{ team_id: string; player_id: string }>;

  const home = lineups.filter(l => l.team_id === homeId).sort((a, b) => (a.batting_order ?? 99) - (b.batting_order ?? 99)).slice(0, 9);
  const away = lineups.filter(l => l.team_id === awayId).sort((a, b) => (a.batting_order ?? 99) - (b.batting_order ?? 99)).slice(0, 9);
  const homeStarter = starters.find(s => s.team_id === homeId) ?? null;
  const awayStarter = starters.find(s => s.team_id === awayId) ?? null;

  if (home.length < 9 || away.length < 9 || !homeStarter || !awayStarter) {
    throw new Error(`diamond-adapter: incomplete roster (home=${home.length} away=${away.length} sp_home=${!!homeStarter} sp_away=${!!awayStarter})`);
  }

  const allPlayerIds = [
    ...home.map(l => l.player_id), ...away.map(l => l.player_id),
    homeStarter.player_id, awayStarter.player_id,
  ];
  const [dnaRes, playersRes] = await Promise.all([
    admin.from("player_dna").select("player_id, contact, power, speed, discipline, consistency").in("player_id", allPlayerIds),
    admin.from("players").select("id, name, bats, throws").in("id", allPlayerIds),
  ]);
  const dnaById = new Map<string, { contact: number; power: number; speed: number; discipline: number }>();
  for (const d of (dnaRes.data ?? []) as any[]) {
    dnaById.set(d.player_id, { contact: d.contact ?? 50, power: d.power ?? 50, speed: d.speed ?? 50, discipline: d.discipline ?? 50 });
  }
  const playerById = new Map<string, { name: string; bats: string | null; throws: string | null }>();
  for (const p of (playersRes.data ?? []) as any[]) {
    playerById.set(p.id, { name: p.name ?? p.id, bats: p.bats ?? null, throws: p.throws ?? null });
  }

  function buildTeam(side: "home" | "away", lineupRows: typeof home, starterRow: NonNullable<typeof homeStarter>): { team: TeamSim; meta: DiamondPlayerMeta[] } {
    const meta: DiamondPlayerMeta[] = [];
    const teamId = side === "home" ? homeId : awayId;
    const oppId = side === "home" ? awayId : homeId;
    const lineup: BatterProfile[] = lineupRows.map((l, idx) => {
      const sid = syntheticIdFor(l.player_id);
      const p = playerById.get(l.player_id);
      const b = batterProfileFromDna(sid, p?.name ?? l.player_id, dnaById.get(l.player_id) ?? null);
      meta.push({
        playerId: l.player_id, playerType: "bat",
        teamId, opponentTeamId: oppId,
        battingOrder: l.batting_order ?? idx + 1,
        handedness: p?.bats ?? null, oppHandedness: null,
        side, syntheticId: sid,
      });
      return b;
    });
    const spId = syntheticIdFor(starterRow.player_id);
    const spInfo = playerById.get(starterRow.player_id);
    const starter = neutralPitcherProfile(spId, spInfo?.name ?? starterRow.player_id, STARTER_BF_REF, 5.5);
    meta.push({
      playerId: starterRow.player_id, playerType: "pit",
      teamId, opponentTeamId: oppId, battingOrder: null,
      handedness: spInfo?.throws ?? null, oppHandedness: null,
      side, syntheticId: spId,
    });
    const bullpen = neutralPitcherProfile(spId ^ 0xdeadbeef, `${side}_bullpen`, BULLPEN_BF_REF, 3.5);
    return {
      team: {
        name: side, abbreviation: side.toUpperCase(),
        lineup, starter, bullpen,
      },
      meta,
    };
  }

  const homeTeam = buildTeam("home", home, homeStarter);
  const awayTeam = buildTeam("away", away, awayStarter);
  const venueId = g.ballpark ? (VENUE_MAP[g.ballpark] ?? null) : null;

  return {
    simInput: {
      home: homeTeam.team, away: awayTeam.team,
      venueId: venueId ?? undefined, iterations: 0, seed: 0,
    },
    meta: [...homeTeam.meta, ...awayTeam.meta],
    venueId,
    homeTeamId: homeId, awayTeamId: awayId,
  };
}

// ─── Simulation chunk ─────────────────────────────────────────────────────

function chunkSeed(jobSeed: string, chunkIndex: number): number {
  const h = createHash("sha256").update(`${jobSeed}::${chunkIndex}`).digest();
  return h.readUInt32BE(0);
}

function ensureAgg(state: AggState, meta: DiamondPlayerMeta, m: DiamondMarket): NonNullable<ReturnType<AggState["get"]>> {
  const key = `${meta.playerId}|${m.market}`;
  let s = state.get(key);
  if (!s) {
    s = {
      market: m.market, threshold: m.threshold,
      hits: 0, sum: 0, n: 0,
      playerType: meta.playerType,
      teamId: meta.teamId, oppTeamId: meta.opponentTeamId,
      battingOrder: meta.battingOrder, handedness: meta.handedness,
      hist: new Array(32).fill(0),
    };
    state.set(key, s);
  }
  return s;
}

function fold(samples: number[], threshold: number | null, useAtLeast: 1 | 2 | null): {
  sum: number; hits: number; hist: number[];
} {
  const hist = new Array(32).fill(0);
  let sum = 0;
  let hits = 0;
  for (const v of samples) {
    sum += v;
    if (v >= 0 && v < 32) hist[v]++;
    if (threshold != null) { if (v > threshold) hits++; }
    else if (useAtLeast === 2) { if (v >= 2) hits++; }
    else { if (v >= 1) hits++; }
  }
  return { sum, hits, hist };
}

/**
 * Run one chunk of real MC iterations and merge into the aggregator state.
 * Returns the per-market delta for durable persistence (avoids replay).
 */
export function simulateDiamondChunk(
  job: SimJobLike,
  chunkIndex: number,
  roster: DiamondRoster,
  state: AggState,
): ChunkDelta {
  const iterations = job.chunk_size;
  const seed = chunkSeed(job.seed ?? job.id, chunkIndex);
  const result = simulate({ ...roster.simInput, iterations, seed });

  const sideBatters = { home: result.samples.homeBatters, away: result.samples.awayBatters };
  const sidePitcher = { home: result.samples.homePitcher, away: result.samples.awayPitcher };

  const delta: ChunkDelta = [];

  function push(meta: DiamondPlayerMeta, m: DiamondMarket, samples: number[]): void {
    const useAtLeast: 1 | 2 | null = m.market === "2plus_hits" ? 2 : m.market === "1plus_hit" || m.market === "hr" ? 1 : null;
    const f = fold(samples, m.threshold, useAtLeast);
    const s = ensureAgg(state, meta, m);
    s.sum += f.sum; s.hits += f.hits; s.n += samples.length;
    for (let i = 0; i < s.hist.length; i++) s.hist[i] += f.hist[i];
    delta.push({
      player_id: meta.playerId, market: m.market, threshold: m.threshold,
      sum: f.sum, hits: f.hits, n: samples.length, hist: f.hist,
      playerType: meta.playerType, teamId: meta.teamId, oppTeamId: meta.opponentTeamId,
      battingOrder: meta.battingOrder, handedness: meta.handedness,
    });
  }

  // Hitters — indexed by lineup position on each side.
  for (const meta of roster.meta.filter((m) => m.playerType === "bat")) {
    const side = meta.side;
    const arr = sideBatters[side];
    const b = arr.find((x) => x.playerId === meta.syntheticId);
    if (!b) continue;
    for (const m of DIAMOND_MARKETS.filter((x) => x.playerType === "bat")) {
      const samples =
        m.stat === "H" ? b.H :
        m.stat === "TB" ? b.TB :
        m.stat === "HR" ? b.HR :
        m.stat === "RBI" ? b.RBI :
        m.stat === "R" ? b.R : [];
      push(meta, m, samples);
    }
  }
  // Starting pitchers.
  for (const meta of roster.meta.filter((m) => m.playerType === "pit")) {
    const side = meta.side;
    const p = sidePitcher[side];
    if (!p || p.playerId !== meta.syntheticId) continue;
    for (const m of DIAMOND_MARKETS.filter((x) => x.playerType === "pit")) {
      const samples =
        m.stat === "K" ? p.K :
        m.stat === "outs" ? p.outs :
        m.stat === "ER" ? p.ER : [];
      push(meta, m, samples);
    }
  }

  return delta;
}

/** Merge a persisted delta back into aggregator state (skip-replay rehydration). */
export function mergeDelta(state: AggState, delta: ChunkDelta): void {
  for (const d of delta) {
    const key = `${d.player_id}|${d.market}`;
    let s = state.get(key);
    if (!s) {
      s = {
        market: d.market, threshold: d.threshold,
        hits: 0, sum: 0, n: 0,
        playerType: d.playerType,
        teamId: d.teamId, oppTeamId: d.oppTeamId,
        battingOrder: d.battingOrder, handedness: d.handedness,
        hist: new Array(32).fill(0),
      };
      state.set(key, s);
    }
    s.sum += d.sum; s.hits += d.hits; s.n += d.n;
    for (let i = 0; i < s.hist.length && i < d.hist.length; i++) s.hist[i] += d.hist[i];
  }
}

/** Compute percentile summary from a merged integer histogram. */
export function percentilesFromHist(hist: number[]): Record<string, number> {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
  const targets = { p10: 0.1, p25: 0.25, p50: 0.5, p75: 0.75, p90: 0.9 } as const;
  const out: Record<string, number> = {};
  let cum = 0;
  const points: Array<{ v: number; c: number }> = [];
  for (let i = 0; i < hist.length; i++) { cum += hist[i]; points.push({ v: i, c: cum }); }
  for (const [k, q] of Object.entries(targets)) {
    const need = q * total;
    const p = points.find((pt) => pt.c >= need);
    out[k] = p?.v ?? 0;
  }
  return out;
}
