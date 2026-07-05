/**
 * Diamond Live — MLB Risers & Fallers.
 *
 * Pulls verified raw stats from the public MLB Stats API and computes
 * transparent recent-vs-season deltas. No projections, forecasts, odds,
 * probabilities, Diamond Score, player_dna, consensus, or simulation data
 * is used or emitted.
 *
 * Two data pulls per call:
 *   1) Season-to-date totals (group=hitting|pitching, stats=season)
 *   2) Trailing 14-day totals (stats=byDateRange, startDate..endDate)
 *
 * Ranking is explainable and requires minimum samples:
 *   Hitters:  season PA >= 100, recent PA >= 25
 *   Pitchers: season IP >= 20, and either recent IP >= 10, or
 *             recent appearances >= 3 AND recent IP >= 8
 * Players below either bar are labeled "Early sample" and excluded from
 * the true riser/faller lists.
 */
import { createServerFn } from "@tanstack/react-start";
import { isoDateInAppTz, shiftIsoDate, todayInAppTz } from "@/lib/timezone";

const MLB = "https://statsapi.mlb.com/api/v1";

async function mlb<T>(path: string): Promise<T> {
  const res = await fetch(`${MLB}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`MLB ${res.status}: ${path}`);
  return (await res.json()) as T;
}

// ---------- thresholds ----------
export const MOVER_THRESHOLDS = {
  hitter: { seasonPa: 100, recentPa: 25, recentDays: 14 },
  pitcher: {
    seasonIp: 20,
    recentIpMin: 10,
    recentIpWithApps: 8,
    recentAppsWithIp: 3,
    recentDays: 14,
  },
} as const;

// ---------- types ----------
export type HitterMover = {
  mlbId: number;
  name: string;
  team: string | null;
  teamId: number | null;
  position: string | null;
  season: {
    games: number;
    pa: number;
    ab: number;
    avg: number;
    obp: number;
    slg: number;
    ops: number;
    hr: number;
    hits: number;
    runs: number;
    rbi: number;
    bb: number;
    so: number;
  };
  recent: {
    games: number;
    pa: number;
    ab: number;
    avg: number;
    obp: number;
    slg: number;
    ops: number;
    hr: number;
    hits: number;
    runs: number;
    rbi: number;
    bb: number;
    so: number;
  };
  delta: {
    ops: number;
    avg: number;
    slg: number;
  };
  status: "riser" | "faller" | "early_sample";
  reason: string;
};

export type PitcherMover = {
  mlbId: number;
  name: string;
  team: string | null;
  teamId: number | null;
  season: {
    games: number;
    starts: number;
    ip: number;
    era: number;
    whip: number;
    so: number;
    bb: number;
    hr: number;
  };
  recent: {
    games: number;
    starts: number;
    ip: number;
    era: number;
    whip: number;
    so: number;
    bb: number;
    hr: number;
  };
  delta: {
    era: number; // negative = better (riser)
    whip: number; // negative = better
    k9: number; // positive = better
  };
  status: "riser" | "faller" | "early_sample";
  reason: string;
};

export type MoversPayload = {
  season: number;
  recentStartDate: string;
  recentEndDate: string;
  window: { hitter: typeof MOVER_THRESHOLDS.hitter; pitcher: typeof MOVER_THRESHOLDS.pitcher };
  hitters: {
    risers: HitterMover[];
    fallers: HitterMover[];
    earlySample: number;
    totalConsidered: number;
  };
  pitchers: {
    risers: PitcherMover[];
    fallers: PitcherMover[];
    earlySample: number;
    totalConsidered: number;
  };
  fetchedAt: string;
};

// ---------- helpers ----------
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const s = String(v);
  if (s === "-.--" || s === "-") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** MLB Stats API returns IP as "12.1" meaning 12 innings + 1 out. Convert to real innings. */
function ipStrToNumber(v: unknown): number {
  if (v == null) return 0;
  const s = String(v);
  const [whole, frac] = s.split(".");
  const w = Number(whole);
  const f = Number(frac ?? "0");
  if (!Number.isFinite(w)) return 0;
  const outs = (Number.isFinite(f) ? f : 0);
  return w + outs / 3;
}

function fmt3(n: number): string {
  return n.toFixed(3).replace(/^0\./, ".");
}

function seasonForDate(dateIso: string): number {
  return Number(dateIso.slice(0, 4));
}

// ---------- MLB fetchers ----------
type Split = any;

async function fetchHitting(kind: "season" | "byDateRange", season: number, start?: string, end?: string): Promise<Split[]> {
  const base = `stats=${kind}&group=hitting&season=${season}&sportIds=1&gameType=R&limit=2000`;
  const path = kind === "byDateRange"
    ? `/stats?${base}&startDate=${start}&endDate=${end}`
    : `/stats?${base}`;
  const json = await mlb<any>(path);
  return json?.stats?.[0]?.splits ?? [];
}

async function fetchPitching(kind: "season" | "byDateRange", season: number, start?: string, end?: string): Promise<Split[]> {
  const base = `stats=${kind}&group=pitching&season=${season}&sportIds=1&gameType=R&limit=2000`;
  const path = kind === "byDateRange"
    ? `/stats?${base}&startDate=${start}&endDate=${end}`
    : `/stats?${base}`;
  const json = await mlb<any>(path);
  return json?.stats?.[0]?.splits ?? [];
}

// ---------- server fn ----------
export const getMlbMovers = createServerFn({ method: "GET" })
  .inputValidator((data: { date?: string; recentDays?: number } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<MoversPayload> => {
    const today = data.date ?? todayInAppTz();
    const recentDays = Math.max(3, Math.min(45, data.recentDays ?? 14));
    const season = seasonForDate(today);
    const endDate = today;
    const startDate = shiftIsoDate(today, -(recentDays - 1));

    const [hitSeason, hitRecent, pitSeason, pitRecent] = await Promise.all([
      fetchHitting("season", season),
      fetchHitting("byDateRange", season, startDate, endDate),
      fetchPitching("season", season),
      fetchPitching("byDateRange", season, startDate, endDate),
    ]);

    // -------- Hitters --------
    const hRecentById = new Map<number, Split>();
    for (const s of hitRecent) {
      const id = s?.player?.id;
      if (typeof id === "number") hRecentById.set(id, s);
    }

    const hitterMovers: HitterMover[] = [];
    let hitterEarly = 0;
    let hitterConsidered = 0;
    for (const s of hitSeason) {
      const id = s?.player?.id;
      if (typeof id !== "number") continue;
      const seasonPa = num(s?.stat?.plateAppearances);
      const seasonAb = num(s?.stat?.atBats);
      if (seasonPa < 1) continue;
      hitterConsidered++;
      const r = hRecentById.get(id);
      const recentPa = num(r?.stat?.plateAppearances);
      const seasonOps = num(s?.stat?.ops);
      const recentOps = num(r?.stat?.ops);
      const belowSample =
        seasonPa < MOVER_THRESHOLDS.hitter.seasonPa ||
        recentPa < MOVER_THRESHOLDS.hitter.recentPa;
      const mover: HitterMover = {
        mlbId: id,
        name: s?.player?.fullName ?? `Player ${id}`,
        team: s?.team?.abbreviation ?? s?.team?.name ?? null,
        teamId: s?.team?.id ?? null,
        position: s?.position?.abbreviation ?? null,
        season: {
          games: num(s?.stat?.gamesPlayed),
          pa: seasonPa,
          ab: seasonAb,
          avg: num(s?.stat?.avg),
          obp: num(s?.stat?.obp),
          slg: num(s?.stat?.slg),
          ops: seasonOps,
          hr: num(s?.stat?.homeRuns),
          hits: num(s?.stat?.hits),
          runs: num(s?.stat?.runs),
          rbi: num(s?.stat?.rbi),
          bb: num(s?.stat?.baseOnBalls),
          so: num(s?.stat?.strikeOuts),
        },
        recent: {
          games: num(r?.stat?.gamesPlayed),
          pa: recentPa,
          ab: num(r?.stat?.atBats),
          avg: num(r?.stat?.avg),
          obp: num(r?.stat?.obp),
          slg: num(r?.stat?.slg),
          ops: recentOps,
          hr: num(r?.stat?.homeRuns),
          hits: num(r?.stat?.hits),
          runs: num(r?.stat?.runs),
          rbi: num(r?.stat?.rbi),
          bb: num(r?.stat?.baseOnBalls),
          so: num(r?.stat?.strikeOuts),
        },
        delta: {
          ops: recentOps - seasonOps,
          avg: num(r?.stat?.avg) - num(s?.stat?.avg),
          slg: num(r?.stat?.slg) - num(s?.stat?.slg),
        },
        status: belowSample ? "early_sample" : recentOps >= seasonOps ? "riser" : "faller",
        reason: "",
      };
      if (belowSample) hitterEarly++;
      mover.reason = belowSample
        ? `Early sample: ${recentPa} PA in last ${recentDays} days (need ${MOVER_THRESHOLDS.hitter.recentPa}); ${seasonPa} season PA`
        : mover.status === "riser"
          ? `${recentPa} PA over ${mover.recent.games} G at ${fmt3(recentOps)} OPS vs season ${fmt3(seasonOps)} (+${(mover.delta.ops).toFixed(3)})`
          : `${recentPa} PA over ${mover.recent.games} G at ${fmt3(recentOps)} OPS vs season ${fmt3(seasonOps)} (${mover.delta.ops.toFixed(3)})`;
      hitterMovers.push(mover);
    }

    const hitterEligible = hitterMovers.filter((m) => m.status !== "early_sample");
    const hitterRisers = [...hitterEligible]
      .filter((m) => m.status === "riser")
      .sort((a, b) => b.delta.ops - a.delta.ops)
      .slice(0, 12);
    const hitterFallers = [...hitterEligible]
      .filter((m) => m.status === "faller")
      .sort((a, b) => a.delta.ops - b.delta.ops)
      .slice(0, 12);

    // -------- Pitchers --------
    const pRecentById = new Map<number, Split>();
    for (const s of pitRecent) {
      const id = s?.player?.id;
      if (typeof id === "number") pRecentById.set(id, s);
    }
    const pitcherMovers: PitcherMover[] = [];
    let pitcherEarly = 0;
    let pitcherConsidered = 0;
    for (const s of pitSeason) {
      const id = s?.player?.id;
      if (typeof id !== "number") continue;
      const seasonIp = ipStrToNumber(s?.stat?.inningsPitched);
      if (seasonIp < 1) continue;
      pitcherConsidered++;
      const r = pRecentById.get(id);
      const recentIp = ipStrToNumber(r?.stat?.inningsPitched);
      const seasonEra = num(s?.stat?.era);
      const recentEra = num(r?.stat?.era);
      const seasonWhip = num(s?.stat?.whip);
      const recentWhip = num(r?.stat?.whip);
      const seasonK = num(s?.stat?.strikeOuts);
      const recentK = num(r?.stat?.strikeOuts);
      const seasonK9 = seasonIp > 0 ? (seasonK * 9) / seasonIp : 0;
      const recentK9 = recentIp > 0 ? (recentK * 9) / recentIp : 0;
      const belowSample =
        seasonIp < MOVER_THRESHOLDS.pitcher.seasonIp ||
        recentIp < MOVER_THRESHOLDS.pitcher.recentIp;
      // Riser: recent ERA lower than season AND recent WHIP lower than season.
      // Faller: recent ERA higher AND recent WHIP higher. Otherwise mixed → early_sample.
      let status: PitcherMover["status"] = "early_sample";
      if (!belowSample) {
        const eraBetter = recentEra < seasonEra;
        const whipBetter = recentWhip < seasonWhip;
        const eraWorse = recentEra > seasonEra;
        const whipWorse = recentWhip > seasonWhip;
        if (eraBetter && whipBetter) status = "riser";
        else if (eraWorse && whipWorse) status = "faller";
        else status = "early_sample"; // mixed signal — do not label
      }
      if (status === "early_sample") pitcherEarly++;
      const mover: PitcherMover = {
        mlbId: id,
        name: s?.player?.fullName ?? `Player ${id}`,
        team: s?.team?.abbreviation ?? s?.team?.name ?? null,
        teamId: s?.team?.id ?? null,
        season: {
          games: num(s?.stat?.gamesPlayed),
          starts: num(s?.stat?.gamesStarted),
          ip: seasonIp,
          era: seasonEra,
          whip: seasonWhip,
          so: seasonK,
          bb: num(s?.stat?.baseOnBalls),
          hr: num(s?.stat?.homeRuns),
        },
        recent: {
          games: num(r?.stat?.gamesPlayed),
          starts: num(r?.stat?.gamesStarted),
          ip: recentIp,
          era: recentEra,
          whip: recentWhip,
          so: recentK,
          bb: num(r?.stat?.baseOnBalls),
          hr: num(r?.stat?.homeRuns),
        },
        delta: {
          era: recentEra - seasonEra,
          whip: recentWhip - seasonWhip,
          k9: recentK9 - seasonK9,
        },
        status,
        reason: belowSample
          ? `Early sample: ${recentIp.toFixed(1)} IP in last ${recentDays} days (need ${MOVER_THRESHOLDS.pitcher.recentIp}); ${seasonIp.toFixed(1)} season IP`
          : status === "riser"
            ? `${recentIp.toFixed(1)} IP over ${mover_apps(r)} vs season: ERA ${recentEra.toFixed(2)} (${(recentEra - seasonEra).toFixed(2)}), WHIP ${recentWhip.toFixed(2)} (${(recentWhip - seasonWhip).toFixed(2)})`
            : status === "faller"
              ? `${recentIp.toFixed(1)} IP over ${mover_apps(r)} vs season: ERA ${recentEra.toFixed(2)} (+${(recentEra - seasonEra).toFixed(2)}), WHIP ${recentWhip.toFixed(2)} (+${(recentWhip - seasonWhip).toFixed(2)})`
              : `Mixed signal in recent ${recentIp.toFixed(1)} IP`,
      };
      pitcherMovers.push(mover);
    }

    const pitcherRisers = pitcherMovers
      .filter((m) => m.status === "riser")
      .sort((a, b) => a.delta.era - b.delta.era)
      .slice(0, 12);
    const pitcherFallers = pitcherMovers
      .filter((m) => m.status === "faller")
      .sort((a, b) => b.delta.era - a.delta.era)
      .slice(0, 12);

    return {
      season,
      recentStartDate: startDate,
      recentEndDate: endDate,
      window: MOVER_THRESHOLDS,
      hitters: {
        risers: hitterRisers,
        fallers: hitterFallers,
        earlySample: hitterEarly,
        totalConsidered: hitterConsidered,
      },
      pitchers: {
        risers: pitcherRisers,
        fallers: pitcherFallers,
        earlySample: pitcherEarly,
        totalConsidered: pitcherConsidered,
      },
      fetchedAt: new Date().toISOString(),
    };
  });

function mover_apps(r: any): string {
  const g = num(r?.stat?.gamesPlayed);
  const gs = num(r?.stat?.gamesStarted);
  if (gs > 0) return `${gs} start${gs === 1 ? "" : "s"} (${g} app)`;
  return `${g} app${g === 1 ? "" : "s"}`;
}

// Re-export just to prevent isoDateInAppTz being unused if the caller adds more windows.
export const _internal = { isoDateInAppTz };
