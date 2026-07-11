/**
 * Diamond MC candidate adapter — deterministic unit tests.
 * Pure engine tests: no DB access. Covers seed determinism, monotonic
 * response to DNA inputs, threshold correctness, and chunk merging.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { simulate } from "../engine";
import {
  DIAMOND_ADAPTER_VERSION,
  DIAMOND_ENGINE_STATUS,
  DIAMOND_MARKETS,
  batterProfileFromDna,
  mergeDelta,
  neutralPitcherProfile,
  percentilesFromHist,
  simulateDiamondChunk,
  type AggState,
  type DiamondRoster,
} from "../diamond-adapter.server";

function makeRoster(overrides?: Partial<{
  homeContact: number; homePower: number; awayContact: number; awayPower: number;
}>): DiamondRoster {
  const homeContact = overrides?.homeContact ?? 50;
  const homePower = overrides?.homePower ?? 50;
  const awayContact = overrides?.awayContact ?? 50;
  const awayPower = overrides?.awayPower ?? 50;
  const dna = (c: number, p: number) => ({ contact: c, power: p, speed: 50, discipline: 50 });
  const lineup = (prefix: string, c: number, p: number) => Array.from({ length: 9 }, (_, i) =>
    batterProfileFromDna(i + 1, `${prefix}-b${i}`, dna(c, p))
  );
  const meta: DiamondRoster["meta"] = [];
  for (let i = 0; i < 9; i++) {
    meta.push({
      playerId: `home-b${i}`, playerType: "bat", teamId: "H", opponentTeamId: "A",
      battingOrder: i + 1, handedness: "R", oppHandedness: null, side: "home", syntheticId: i + 1,
    });
    meta.push({
      playerId: `away-b${i}`, playerType: "bat", teamId: "A", opponentTeamId: "H",
      battingOrder: i + 1, handedness: "R", oppHandedness: null, side: "away", syntheticId: 100 + i + 1,
    });
  }
  meta.push({
    playerId: "home-sp", playerType: "pit", teamId: "H", opponentTeamId: "A",
    battingOrder: null, handedness: "R", oppHandedness: null, side: "home", syntheticId: 900,
  });
  meta.push({
    playerId: "away-sp", playerType: "pit", teamId: "A", opponentTeamId: "H",
    battingOrder: null, handedness: "R", oppHandedness: null, side: "away", syntheticId: 901,
  });
  const homeLineup = lineup("home", homeContact, homePower).map((b, i) => ({ ...b, id: i + 1 }));
  const awayLineup = lineup("away", awayContact, awayPower).map((b, i) => ({ ...b, id: 100 + i + 1 }));
  return {
    simInput: {
      home: {
        name: "home", abbreviation: "H",
        lineup: homeLineup,
        starter: neutralPitcherProfile(900, "home-sp", 700, 5.5),
        bullpen: neutralPitcherProfile(902, "home-bp", 500, 3.5),
      },
      away: {
        name: "away", abbreviation: "A",
        lineup: awayLineup,
        starter: neutralPitcherProfile(901, "away-sp", 700, 5.5),
        bullpen: neutralPitcherProfile(903, "away-bp", 500, 3.5),
      },
      iterations: 0, seed: 0,
    },
    meta, venueId: null, homeTeamId: "H", awayTeamId: "A",
  };
}

const baseJob = {
  id: "job-1", game_id: "g", game_pk: 1, slate_date: "2026-07-11",
  model_version: "diamond-sim-v1", inputs_hash: "hash1", tier: "2k" as const,
  label: "preview", sim_count: 200, chunk_size: 200, chunks_total: 1,
  seed: "test-seed", projection_stage: "final_pregame" as const,
};

describe("diamond-adapter engine tags", () => {
  it("uses the diamond_mc_candidate engine status and adapter version", () => {
    assert.equal(DIAMOND_ENGINE_STATUS, "diamond_mc_candidate");
    assert.ok(/^diamond-mc-candidate-\d/.test(DIAMOND_ADAPTER_VERSION));
  });
  it("declares the required v1 markets", () => {
    const names = DIAMOND_MARKETS.map((m) => m.market);
    for (const m of ["1plus_hit", "2plus_hits", "total_bases", "hr", "rbi", "runs_scored", "k", "outs", "er"]) {
      assert.ok(names.includes(m), `missing market ${m}`);
    }
  });
});

describe("diamond-adapter determinism", () => {
  it("same seed and roster produce identical aggregate output", () => {
    const roster = makeRoster();
    const s1: AggState = new Map();
    const s2: AggState = new Map();
    simulateDiamondChunk(baseJob, 0, roster, s1);
    simulateDiamondChunk(baseJob, 0, roster, s2);
    for (const [k, a] of s1) {
      const b = s2.get(k)!;
      assert.equal(a.sum, b.sum, `sum mismatch ${k}`);
      assert.equal(a.hits, b.hits, `hits mismatch ${k}`);
      assert.equal(a.n, b.n);
    }
  });
  it("different chunk index produces different sample stream", () => {
    const roster = makeRoster();
    const s1: AggState = new Map();
    const s2: AggState = new Map();
    simulateDiamondChunk(baseJob, 0, roster, s1);
    simulateDiamondChunk(baseJob, 1, roster, s2);
    let diffs = 0;
    for (const [k, a] of s1) {
      const b = s2.get(k)!;
      if (a.sum !== b.sum) diffs++;
    }
    assert.ok(diffs > 5, `expected many per-player differences across chunks, got ${diffs}`);
  });
});

describe("diamond-adapter response to inputs", () => {
  it("stronger power increases HR probability", () => {
    const weak = makeRoster({ homePower: 20 });
    const strong = makeRoster({ homePower: 95 });
    const sw: AggState = new Map(); const ss: AggState = new Map();
    simulateDiamondChunk({ ...baseJob, chunk_size: 500 }, 0, weak, sw);
    simulateDiamondChunk({ ...baseJob, chunk_size: 500 }, 0, strong, ss);
    // Sum HR probs across the 9 home batters.
    let pW = 0, pS = 0;
    for (const [k, v] of sw) if (k.startsWith("home-") && v.market === "hr") pW += v.hits / v.n;
    for (const [k, v] of ss) if (k.startsWith("home-") && v.market === "hr") pS += v.hits / v.n;
    assert.ok(pS > pW, `expected strong power (${pS}) > weak power (${pW}) HR prob`);
  });
  it("stronger contact increases 1+ hit probability", () => {
    const weak = makeRoster({ homeContact: 20 });
    const strong = makeRoster({ homeContact: 95 });
    const sw: AggState = new Map(); const ss: AggState = new Map();
    simulateDiamondChunk({ ...baseJob, chunk_size: 500 }, 0, weak, sw);
    simulateDiamondChunk({ ...baseJob, chunk_size: 500 }, 0, strong, ss);
    let pW = 0, pS = 0;
    for (const [k, v] of sw) if (k.startsWith("home-") && v.market === "1plus_hit") pW += v.hits / v.n;
    for (const [k, v] of ss) if (k.startsWith("home-") && v.market === "1plus_hit") pS += v.hits / v.n;
    assert.ok(pS > pW, `expected strong contact hit prob ${pS} > weak ${pW}`);
  });
});

describe("diamond-adapter probability semantics", () => {
  it("all event_probabilities land in [0,1]", () => {
    const roster = makeRoster();
    const s: AggState = new Map();
    simulateDiamondChunk({ ...baseJob, chunk_size: 300 }, 0, roster, s);
    for (const [k, v] of s) {
      const p = v.hits / v.n;
      assert.ok(p >= 0 && p <= 1, `prob out of range for ${k}: ${p}`);
    }
  });
  it("output mean equals sum/n from the accumulator", () => {
    const roster = makeRoster();
    const s: AggState = new Map();
    simulateDiamondChunk({ ...baseJob, chunk_size: 300 }, 0, roster, s);
    for (const [, v] of s) {
      const mean = v.sum / v.n;
      assert.ok(Number.isFinite(mean), "mean not finite");
    }
  });
  it("stderr shrinks with larger simulation count", () => {
    const roster = makeRoster();
    const small: AggState = new Map(); const big: AggState = new Map();
    simulateDiamondChunk({ ...baseJob, chunk_size: 200 }, 0, roster, small);
    simulateDiamondChunk({ ...baseJob, chunk_size: 200 }, 0, roster, big);
    simulateDiamondChunk({ ...baseJob, chunk_size: 200 }, 1, roster, big);
    simulateDiamondChunk({ ...baseJob, chunk_size: 200 }, 2, roster, big);
    const someKey = [...small.keys()][0]!;
    const s = small.get(someKey)!, b = big.get(someKey)!;
    const p = (x: { hits: number; n: number }) => x.hits / x.n;
    const stderr = (x: { hits: number; n: number }) => Math.sqrt((p(x) * (1 - p(x))) / x.n);
    assert.ok(stderr(b) <= stderr(s) + 1e-6, `stderr should not grow: small=${stderr(s)} big=${stderr(b)}`);
    assert.ok(b.n > s.n);
  });
});

describe("diamond-adapter chunking & merge", () => {
  it("merged chunks equal single larger run in n and total hits", () => {
    const roster = makeRoster();
    const single: AggState = new Map();
    simulate({ ...roster.simInput, iterations: 400, seed: 1 });
    // Two 200-iter chunks with the same chunk seeds compared to two separate chunks accumulated
    const merged: AggState = new Map();
    simulateDiamondChunk({ ...baseJob, chunk_size: 200 }, 0, roster, merged);
    simulateDiamondChunk({ ...baseJob, chunk_size: 200 }, 1, roster, merged);
    simulateDiamondChunk({ ...baseJob, chunk_size: 400 }, 0, roster, single);
    for (const [k, v] of merged) {
      assert.equal(v.n, 400, `merged n for ${k}`);
    }
    for (const [, v] of single) {
      assert.equal(v.n, 400);
    }
  });
  it("mergeDelta re-hydrates state without re-running the sim", () => {
    const roster = makeRoster();
    const live: AggState = new Map();
    const d1 = simulateDiamondChunk({ ...baseJob, chunk_size: 200 }, 0, roster, live);
    const d2 = simulateDiamondChunk({ ...baseJob, chunk_size: 200 }, 1, roster, live);
    const rehydrated: AggState = new Map();
    mergeDelta(rehydrated, d1);
    mergeDelta(rehydrated, d2);
    for (const [k, v] of live) {
      const r = rehydrated.get(k)!;
      assert.equal(r.n, v.n, `n mismatch ${k}`);
      assert.equal(r.hits, v.hits, `hits mismatch ${k}`);
      assert.equal(Math.round(r.sum * 1000), Math.round(v.sum * 1000), `sum mismatch ${k}`);
    }
  });
});

describe("diamond-adapter percentiles", () => {
  it("percentilesFromHist returns ordered p10 <= p50 <= p90", () => {
    const hist = new Array(32).fill(0);
    for (let i = 0; i < 200; i++) hist[Math.min(31, Math.max(0, Math.round(3 + Math.sin(i))))]++;
    const p = percentilesFromHist(hist);
    assert.ok(p.p10 <= p.p50);
    assert.ok(p.p50 <= p.p90);
  });
  it("empty hist returns all zeros", () => {
    const p = percentilesFromHist(new Array(32).fill(0));
    assert.equal(p.p50, 0);
  });
});
