/**
 * Diamond Official Simulation — enqueue helper.
 *
 * Phase 2 (dry-run): computes a per-game inputs hash, decides which sim
 * tiers/labels are ready, and inserts `sim_jobs` rows. No worker executes
 * these jobs yet; the queue is being validated against live slates first.
 *
 * Rules:
 *   - Idempotent by (game_id, model_version, inputs_hash, tier, label);
 *     the unique index turns a repeat enqueue into a no-op.
 *   - Never enqueues once the game has reached first pitch.
 *   - 20K tier is chunked into 10 × 2,000 (per approved plan).
 *   - Weather hashing uses a stricter, sim-only threshold (see WEATHER_BUCKET).
 *
 * Server-only. Uses the service-role client from the orchestrator.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

export const SIM_MODEL_VERSION = "diamond-sim-v1";

const CHUNK_2K = { simCount: 2_000, chunkSize: 500, chunksTotal: 4 };
const CHUNK_20K = { simCount: 20_000, chunkSize: 2_000, chunksTotal: 10 };

// Stricter, sim-only weather bucketing. A change that crosses any bucket
// boundary flips the inputs_hash and requeues 20K.
const WEATHER_BUCKET = {
  tempF: 3,      // vs engine's coarser threshold
  windMph: 2,
  precipPct: 5,
};

export type EnqueuePerGame = {
  gameId: string;
  gamePk: number;
  firstPitchAt: string | null;
  inputsHash: string;
  startersReady: boolean;
  lineupsProjected: boolean;
  lineupsConfirmed: boolean;
  enqueued: Array<{ tier: "2k" | "20k"; label: "preview" | "early_slate" | "confirmed"; jobId: string | null; noop: boolean; reason?: string }>;
  skippedReason?: string;
};

export type EnqueueResult = {
  slateDate: string;
  gamesConsidered: number;
  rowsEnqueued: number;
  perGame: EnqueuePerGame[];
  error?: string;
};

function bucket(value: number | null | undefined, size: number): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Math.round(value / size) * size;
}

function weatherFingerprint(weather: unknown): Record<string, number | null> {
  const w = (weather ?? {}) as Record<string, unknown>;
  const temp = typeof w.temperature_f === "number" ? w.temperature_f : typeof w.temp_f === "number" ? w.temp_f : null;
  const wind = typeof w.wind_mph === "number" ? w.wind_mph : null;
  const precip = typeof w.precip_pct === "number" ? w.precip_pct : typeof w.precipitation_pct === "number" ? w.precipitation_pct : null;
  return {
    tempF: bucket(temp, WEATHER_BUCKET.tempF),
    windMph: bucket(wind, WEATHER_BUCKET.windMph),
    precipPct: bucket(precip, WEATHER_BUCKET.precipPct),
  };
}

function hashInputs(payload: unknown): string {
  const json = JSON.stringify(payload);
  return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

type GameRow = {
  id: string;
  mlb_game_id: number | null;
  ballpark: string | null;
  weather: unknown;
  game_status: string | null;
  first_pitch_at: string | null;
  home_team_id: string;
  away_team_id: string;
};

type StarterRow = { game_id: string; team_id: string; player_id: string; confirmed: boolean };
type LineupRow = { game_id: string; team_id: string; player_id: string; batting_order: number | null; confirmed: boolean };

function isPregame(firstPitchAt: string | null, gameStatus: string | null): boolean {
  if (gameStatus && !["scheduled", "pre-game", "preview", "warmup"].includes(gameStatus.toLowerCase())) {
    // Any non-pregame status disqualifies (live/final/postponed/etc.)
    if (["final", "game over", "completed early", "postponed", "cancelled", "suspended", "in progress", "live"].includes(gameStatus.toLowerCase())) {
      return false;
    }
  }
  if (!firstPitchAt) return true; // unknown first pitch — treat as pregame; worker also checks.
  return new Date(firstPitchAt).getTime() > Date.now();
}

export async function enqueueSimJobsForDate(
  supabaseAdmin: SupabaseClient,
  slateDate: string,
): Promise<EnqueueResult> {
  const result: EnqueueResult = { slateDate, gamesConsidered: 0, rowsEnqueued: 0, perGame: [] };

  const { data: games, error: gErr } = await supabaseAdmin
    .from("games")
    .select("id, mlb_game_id, ballpark, weather, game_status, first_pitch_at, home_team_id, away_team_id")
    .eq("date", slateDate);
  if (gErr) { result.error = `games query failed: ${gErr.message}`; return result; }
  if (!games || games.length === 0) return result;

  result.gamesConsidered = games.length;
  const gameIds = games.map((g: GameRow) => g.id);

  const [{ data: startersRaw, error: sErr }, { data: lineupsRaw, error: lErr }] = await Promise.all([
    supabaseAdmin.from("starting_pitchers")
      .select("game_id, team_id, player_id, confirmed")
      .in("game_id", gameIds),
    supabaseAdmin.from("lineups")
      .select("game_id, team_id, player_id, batting_order, confirmed")
      .in("game_id", gameIds),
  ]);
  if (sErr) { result.error = `starters query failed: ${sErr.message}`; return result; }
  if (lErr) { result.error = `lineups query failed: ${lErr.message}`; return result; }

  const startersByGame = new Map<string, StarterRow[]>();
  for (const s of (startersRaw ?? []) as StarterRow[]) {
    const arr = startersByGame.get(s.game_id) ?? [];
    arr.push(s);
    startersByGame.set(s.game_id, arr);
  }

  const lineupsByGame = new Map<string, LineupRow[]>();
  for (const l of (lineupsRaw ?? []) as LineupRow[]) {
    const arr = lineupsByGame.get(l.game_id) ?? [];
    arr.push(l);
    lineupsByGame.set(l.game_id, arr);
  }

  for (const g of games as GameRow[]) {
    const perGame: EnqueuePerGame = {
      gameId: g.id,
      gamePk: g.mlb_game_id ?? 0,
      firstPitchAt: g.first_pitch_at,
      inputsHash: "",
      startersReady: false,
      lineupsProjected: false,
      lineupsConfirmed: false,
      enqueued: [],
    };

    if (!isPregame(g.first_pitch_at, g.game_status)) {
      perGame.skippedReason = "not pregame";
      result.perGame.push(perGame);
      continue;
    }
    if (!g.mlb_game_id) {
      perGame.skippedReason = "missing mlb_game_id";
      result.perGame.push(perGame);
      continue;
    }

    const starters = startersByGame.get(g.id) ?? [];
    const homeStarter = starters.find(s => s.team_id === g.home_team_id) ?? null;
    const awayStarter = starters.find(s => s.team_id === g.away_team_id) ?? null;
    perGame.startersReady = !!(homeStarter?.player_id && awayStarter?.player_id);

    const lineupRows = lineupsByGame.get(g.id) ?? [];
    const home = lineupRows.filter(l => l.team_id === g.home_team_id).sort((a, b) => (a.batting_order ?? 99) - (b.batting_order ?? 99));
    const away = lineupRows.filter(l => l.team_id === g.away_team_id).sort((a, b) => (a.batting_order ?? 99) - (b.batting_order ?? 99));
    perGame.lineupsProjected = home.length >= 9 && away.length >= 9;
    perGame.lineupsConfirmed =
      perGame.lineupsProjected &&
      home.slice(0, 9).every(l => l.confirmed) &&
      away.slice(0, 9).every(l => l.confirmed);

    const hashPayload = {
      m: SIM_MODEL_VERSION,
      g: g.mlb_game_id,
      p: g.ballpark ?? null,
      w: weatherFingerprint(g.weather),
      sp: {
        h: homeStarter?.player_id ?? null,
        a: awayStarter?.player_id ?? null,
        hc: !!homeStarter?.confirmed,
        ac: !!awayStarter?.confirmed,
      },
      lu: {
        h: home.slice(0, 9).map(l => ({ p: l.player_id, o: l.batting_order, c: !!l.confirmed })),
        a: away.slice(0, 9).map(l => ({ p: l.player_id, o: l.batting_order, c: !!l.confirmed })),
        hLen: home.length,
        aLen: away.length,
      },
    };
    perGame.inputsHash = hashInputs(hashPayload);

    // Decide which tiers/labels to enqueue for the current hash.
    // 2K Preview: allowed as soon as starters are known (lightweight fallback).
    // 20K Early Slate: starters + projected lineups ready.
    // 20K Confirmed: full confirmed lineups.
    const targets: Array<{ tier: "2k" | "20k"; label: "preview" | "early_slate" | "confirmed"; ready: boolean }> = [
      { tier: "2k", label: "preview", ready: perGame.startersReady },
      { tier: "20k", label: "early_slate", ready: perGame.startersReady && perGame.lineupsProjected },
      { tier: "20k", label: "confirmed", ready: perGame.startersReady && perGame.lineupsConfirmed },
    ];

    for (const t of targets) {
      if (!t.ready) {
        perGame.enqueued.push({ tier: t.tier, label: t.label, jobId: null, noop: true, reason: "not ready" });
        continue;
      }
      const chunks = t.tier === "20k" ? CHUNK_20K : CHUNK_2K;
      const insert = {
        game_id: g.id,
        game_pk: g.mlb_game_id,
        slate_date: slateDate,
        model_version: SIM_MODEL_VERSION,
        inputs_hash: perGame.inputsHash,
        tier: t.tier,
        label: t.label,
        sim_count: chunks.simCount,
        chunk_size: chunks.chunkSize,
        chunks_total: chunks.chunksTotal,
        seed: `${g.mlb_game_id}:${perGame.inputsHash}:${t.tier}:${t.label}`,
        seed_meta: { deterministic: true, source: "enqueue_sims" },
        status: "queued",
      };
      const { data, error } = await supabaseAdmin
        .from("sim_jobs")
        .insert(insert)
        .select("id")
        .single();
      if (error) {
        // Unique-violation on the idempotency key = no-op (already enqueued).
        if ((error as { code?: string }).code === "23505") {
          perGame.enqueued.push({ tier: t.tier, label: t.label, jobId: null, noop: true, reason: "already queued" });
        } else {
          perGame.enqueued.push({ tier: t.tier, label: t.label, jobId: null, noop: false, reason: `insert failed: ${error.message}` });
        }
        continue;
      }
      perGame.enqueued.push({ tier: t.tier, label: t.label, jobId: data?.id ?? null, noop: false });
      result.rowsEnqueued += 1;
    }

    result.perGame.push(perGame);
  }

  return result;
}
