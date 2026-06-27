/**
 * Forecast Snapshot Lifecycle.
 *
 * Single write path for official Diamond forecasts. Reads never call this
 * module. Generation is gated by the canonical material input hash and a
 * partial unique index that enforces one active (published|locked) run per
 * (game_pk, model_version) at any time.
 *
 * Decisions:
 *   awaiting       — lineups/pitchers incomplete; no sim, no version bump
 *   noop           — input hash matches latest published; no sim
 *   published      — first publish; new version 1
 *   superseded     — input hash changed before first pitch; new version N
 *   locked-skip    — game already locked or in progress; no new run
 *
 * First-pitch hard stop: once game_status indicates the game has started or
 * passed start time, no new pregame forecast can be created — even with
 * admin force.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeMaterialInputHash,
  deterministicSeed,
  validateMaterialInputs,
  type MaterialInputs,
} from "./material-hash";

export type LifecycleDecision =
  | "awaiting"
  | "noop"
  | "published"
  | "superseded"
  | "locked-skip"
  | "post-first-pitch-skip"
  | "official-exists-preview-blocked"
  | "ineligible-for-official"
  | "error";

/**
 * Forecast class governs PUBLIC visibility. Orthogonal to status.
 *   official          — built from confirmed lineups + confirmed starters
 *   preview           — admin-only exploratory sim (partial/projected lineups)
 *   legacy_unverified — pre-lifecycle row; never public, never calibration
 *
 * Note: `locked` is a status, not a class. An official run keeps
 * forecast_class='official' after first pitch; its status changes to 'locked'.
 */
export type ForecastClass = "official" | "preview";

export type LifecycleLogEntry = {
  gamePk: number;
  modelVersion: string;
  priorStatus: string | null;
  priorHash: string | null;
  newHash: string | null;
  decision: LifecycleDecision;
  versionNumber: number | null;
  triggerReason: string;
  actor: string | null;
  durationMs: number;
  message?: string;
};

export type LifecycleResult = {
  decision: LifecycleDecision;
  forecastRunId: string | null;
  versionNumber: number | null;
  log: LifecycleLogEntry;
};

// Re-export the canonical first-pitch cutoff (lives in window.ts so every
// write path shares one definition). External callers still import from
// this module for backwards compatibility.
export { gameHasStartedOrPastStart } from "./window";
import { gameHasStartedOrPastStart } from "./window";

type RunRow = {
  id: string;
  game_pk: number;
  game_id: string;
  model_version: string;
  version_number: number;
  status: string;
  input_hash: string | null;
  generated_at: string;
  locked_at: string | null;
};

export type SimulateAndBuildResult = {
  projections: Array<{
    player_id: string;
    mlb_id: number | null;
    role: "hitter" | "pitcher";
    diamond_score: number | null;
    confidence: number | null;
    contact_score: number | null;
    power_score: number | null;
    speed_score: number | null;
    pitcher_grade: number | null;
    matchup_grade: number | null;
    hit_probability: number | null;
    total_base_probability: number | null;
    hr_probability: number | null;
    rbi_probability: number | null;
    sb_probability: number | null;
    run_probability: number | null;
    pitcher_win_probability: number | null;
    quality_start_probability: number | null;
    projected_outs: number | null;
    environment_agreement: number | null;
    distributions: Record<string, unknown> | null;
    inputs: Record<string, unknown> | null;
  }>;
};

export type LifecycleContext = {
  admin: SupabaseClient<any>;
  /** Pure: given material inputs + seed, run sim and build per-player projection rows. */
  simulateAndBuild: (args: {
    inputs: MaterialInputs;
    seed: number;
    gameId: string;
  }) => Promise<SimulateAndBuildResult>;
};

export type PublishArgs = {
  gamePk: number;
  modelVersion: string;
  triggerReason: string;
  actor?: string | null;
  notes?: string | null;
  /** Admin override: bypass hash-equality check (still respects first-pitch lock). */
  force?: boolean;
  /**
   * Intended forecast class. Default 'official'. The lifecycle does its own
   * eligibility verification — 'official' is only honored when the candidate
   * inputs validate (9-deep lineups + both starters). Otherwise it short-circuits
   * to `ineligible-for-official` and writes nothing.
   *
   * 'preview' may be created from partial/projected inputs (still requires the
   * sim to be runnable). Preview NEVER supersedes or overwrites an active
   * official/locked run for the same (game_pk, model_version).
   */
  forecastClass?: ForecastClass;
  /** Resolved material inputs. If null, the lifecycle records "awaiting_lineups". */
  candidateInputs: Partial<MaterialInputs>;
  /** Game DB row (must include id, date, game_status, first_pitch_at). */
  game: {
    id: string;
    mlb_game_id: number;
    date: string;
    game_status: string | null;
    first_pitch_at: string | null;
  };
};

async function fetchLatestRun(
  admin: SupabaseClient<any>,
  gamePk: number,
  modelVersion: string,
  forecastClass: ForecastClass,
): Promise<RunRow | null> {
  const { data } = await admin
    .from("forecast_runs")
    .select("id, game_pk, game_id, model_version, version_number, status, input_hash, generated_at, locked_at")
    .eq("game_pk", gamePk)
    .eq("model_version", modelVersion)
    .eq("projection_class", forecastClass)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RunRow | null) ?? null;
}

async function fetchActiveRun(
  admin: SupabaseClient<any>,
  gamePk: number,
  modelVersion: string,
  forecastClass: ForecastClass,
): Promise<RunRow | null> {
  const { data } = await admin
    .from("forecast_runs")
    .select("id, game_pk, game_id, model_version, version_number, status, input_hash, generated_at, locked_at")
    .eq("game_pk", gamePk)
    .eq("model_version", modelVersion)
    .eq("projection_class", forecastClass)
    .in("status", ["published", "locked"])
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RunRow | null) ?? null;
}



function logLine(entry: LifecycleLogEntry) {
  // Compact server-side log per spec.
  // eslint-disable-next-line no-console
  console.log("[forecast.lifecycle]", JSON.stringify(entry));
}

/**
 * Idempotent forecast publish. Safe to call repeatedly; no-ops when the
 * material inputs are unchanged. Locked runs are immutable.
 */
export async function publishForecastIfEligible(
  ctx: LifecycleContext,
  args: PublishArgs,
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const {
    gamePk,
    modelVersion,
    triggerReason,
    actor = null,
    notes = null,
    force = false,
    candidateInputs,
    game,
  } = args;
  const forecastClass: ForecastClass = args.forecastClass ?? "official";

  const baseLog = (
    decision: LifecycleDecision,
    priorRun: RunRow | null,
    newHash: string | null,
    versionNumber: number | null,
    message?: string,
  ): LifecycleLogEntry => ({
    gamePk,
    modelVersion,
    priorStatus: priorRun?.status ?? null,
    priorHash: priorRun?.input_hash ?? null,
    newHash,
    decision,
    versionNumber,
    triggerReason,
    actor,
    durationMs: Date.now() - startedAt,
    message: message ? `[${forecastClass}] ${message}` : `[${forecastClass}]`,
  });

  // Always read the latest run of the SAME class first for status/hash comparison.
  const latest = await fetchLatestRun(ctx.admin, gamePk, modelVersion, forecastClass);

  // FIRST-PITCH HARD STOP — no new pregame forecasts after the window closes.
  if (gameHasStartedOrPastStart(game.game_status, game.first_pitch_at)) {
    // If there is a currently published OFFICIAL run, lock it (idempotent).
    // Preview runs are never locked — they expire silently.
    if (forecastClass === "official") {
      const active = await fetchActiveRun(ctx.admin, gamePk, modelVersion, "official");
      if (active && active.status === "published") {
        await ctx.admin
          .from("forecast_runs")
          .update({ status: "locked", locked_at: new Date().toISOString() })
          .eq("id", active.id);
      }
    }
    const log = baseLog(
      "post-first-pitch-skip",
      latest,
      null,
      latest?.version_number ?? null,
      "game has started or first pitch passed",
    );
    logLine(log);
    return {
      decision: "post-first-pitch-skip",
      forecastRunId: latest?.id ?? null,
      versionNumber: latest?.version_number ?? null,
      log,
    };
  }

  if (latest?.status === "locked") {
    const log = baseLog("locked-skip", latest, latest.input_hash, latest.version_number);
    logLine(log);
    return {
      decision: "locked-skip",
      forecastRunId: latest.id,
      versionNumber: latest.version_number,
      log,
    };
  }

  // PREVIEW GUARDRAIL: never shadow an active official forecast. Preview rows
  // must never compete with or overwrite an official/locked snapshot for the
  // same (game_pk, model_version).
  if (forecastClass === "preview") {
    const activeOfficial = await fetchActiveRun(ctx.admin, gamePk, modelVersion, "official");
    if (activeOfficial) {
      const log = baseLog(
        "official-exists-preview-blocked",
        latest,
        null,
        latest?.version_number ?? null,
        "active official forecast exists; preview generation refused",
      );
      logLine(log);
      return {
        decision: "official-exists-preview-blocked",
        forecastRunId: activeOfficial.id,
        versionNumber: activeOfficial.version_number,
        log,
      };
    }
  }

  // Validate material inputs.
  const check = validateMaterialInputs(candidateInputs);
  if (!check.ok) {
    // For OFFICIAL: write nothing. The public read path surfaces
    // "Awaiting confirmed lineups" purely from current DB state — no sentinel
    // row needed, and writing one would create misleading per-class history.
    if (forecastClass === "official") {
      const log = baseLog(
        "ineligible-for-official",
        latest,
        null,
        latest?.version_number ?? null,
        check.reason,
      );
      logLine(log);
      return {
        decision: "ineligible-for-official",
        forecastRunId: latest?.id ?? null,
        versionNumber: latest?.version_number ?? null,
        log,
      };
    }
    // For PREVIEW: sim cannot run without 9 hitters + 2 SPs; surface awaiting.
    const log = baseLog("awaiting", latest, null, latest?.version_number ?? null, check.reason);
    logLine(log);
    return {
      decision: "awaiting",
      forecastRunId: latest?.id ?? null,
      versionNumber: latest?.version_number ?? null,
      log,
    };
  }

  const inputHash = computeMaterialInputHash(check.inputs);

  // NOOP — same inputs, already published, and no admin force.
  if (!force && latest?.status === "published" && latest.input_hash === inputHash) {
    const log = baseLog("noop", latest, inputHash, latest.version_number);
    logLine(log);
    return {
      decision: "noop",
      forecastRunId: latest.id,
      versionNumber: latest.version_number,
      log,
    };
  }

  // Generate. Deterministic seed: same valid inputs ⇒ same engine output.
  const seed = deterministicSeed(gamePk, inputHash, modelVersion);
  const built = await ctx.simulateAndBuild({ inputs: check.inputs, seed, gameId: game.id });

  const newVersionNumber = (latest?.version_number ?? 0) + 1;
  const newRunId = await insertRunWithSupersede(ctx.admin, {
    gamePk,
    gameId: game.id,
    slateDate: game.date,
    modelVersion,
    forecastClass,
    versionNumber: newVersionNumber,
    status: "published",
    triggerReason,
    inputHash,
    seed,
    materialInputs: check.inputs as unknown as Record<string, unknown>,
    actor,
    notes,
    priorPublishedId:
      latest?.status === "published" ? latest.id : null,
  });

  if (!newRunId) {
    // Lost the supersede race — another writer just published. Reload and return.
    const winner = await fetchActiveRun(ctx.admin, gamePk, modelVersion, forecastClass);
    const log = baseLog(
      "noop",
      latest,
      inputHash,
      winner?.version_number ?? null,
      "concurrent publish detected; returning current active",
    );
    logLine(log);
    return {
      decision: "noop",
      forecastRunId: winner?.id ?? null,
      versionNumber: winner?.version_number ?? null,
      log,
    };
  }

  // Insert per-player projection rows.
  if (built.projections.length) {
    const rows = built.projections.map((p) => ({
      forecast_run_id: newRunId,
      player_id: p.player_id,
      mlb_id: p.mlb_id,
      role: p.role,
      diamond_score: p.diamond_score,
      confidence: p.confidence,
      contact_score: p.contact_score,
      power_score: p.power_score,
      speed_score: p.speed_score,
      pitcher_grade: p.pitcher_grade,
      matchup_grade: p.matchup_grade,
      hit_probability: p.hit_probability,
      total_base_probability: p.total_base_probability,
      hr_probability: p.hr_probability,
      rbi_probability: p.rbi_probability,
      sb_probability: p.sb_probability,
      run_probability: p.run_probability,
      pitcher_win_probability: p.pitcher_win_probability,
      quality_start_probability: p.quality_start_probability,
      projected_outs: p.projected_outs,
      environment_agreement: p.environment_agreement,
      distributions: p.distributions as any,
      inputs: p.inputs as any,
    }));
    const { error } = await ctx.admin
      .from("forecast_player_projections")
      .upsert(rows, { onConflict: "forecast_run_id,player_id" });
    if (error) {
      const log = baseLog("error", latest, inputHash, newVersionNumber, error.message);
      logLine(log);
      return { decision: "error", forecastRunId: newRunId, versionNumber: newVersionNumber, log };
    }
  }

  const decision: LifecycleDecision = latest?.status === "published" ? "superseded" : "published";
  const log = baseLog(decision, latest, inputHash, newVersionNumber);
  logLine(log);
  return { decision, forecastRunId: newRunId, versionNumber: newVersionNumber, log };
}

/**
 * Insert a new published run, marking any prior published run of the SAME
 * forecast_class as superseded in the same transactional intent. The partial
 * unique index `(game_pk, model_version) WHERE forecast_class='official' AND
 * status IN ('published','locked')` is the concurrency backstop for official
 * runs — on conflict we return null so the caller reloads the winning run.
 */
async function insertRunWithSupersede(
  admin: SupabaseClient<any>,
  args: {
    gamePk: number;
    gameId: string;
    slateDate: string;
    modelVersion: string;
    forecastClass: ForecastClass;
    versionNumber: number;
    status: "published";
    triggerReason: string;
    inputHash: string;
    seed: number;
    materialInputs: Record<string, unknown>;
    actor: string | null;
    notes: string | null;
    priorPublishedId: string | null;
  },
): Promise<string | null> {
  // Mark prior published row as superseded BEFORE insert (to free the partial
  // unique slot). If we crash between these statements, the next call sees a
  // stale "superseded" and inserts cleanly.
  if (args.priorPublishedId) {
    const { error: supErr } = await admin
      .from("forecast_runs")
      .update({ status: "superseded" })
      .eq("id", args.priorPublishedId)
      .eq("status", "published"); // only if still published
    if (supErr) {
      // eslint-disable-next-line no-console
      console.warn("[forecast.lifecycle] supersede failed:", supErr.message);
    }
  }

  const { data, error } = await admin
    .from("forecast_runs")
    .insert({
      game_pk: args.gamePk,
      game_id: args.gameId,
      slate_date: args.slateDate,
      model_version: args.modelVersion,
      projection_class: args.forecastClass,
      version_number: args.versionNumber,
      status: args.status,
      trigger_reason: args.triggerReason,
      input_hash: args.inputHash,
      simulation_seed: String(args.seed),
      material_inputs: args.materialInputs as any,
      created_by: args.actor,
      notes: args.notes,
      superseded_by: null,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    // Unique violation on partial index → concurrent winner.
    // eslint-disable-next-line no-console
    console.warn("[forecast.lifecycle] insert failed:", error.message);
    return null;
  }
  if (args.priorPublishedId && data?.id) {
    await admin
      .from("forecast_runs")
      .update({ superseded_by: data.id })
      .eq("id", args.priorPublishedId);
  }
  return data?.id ?? null;
}

/**
 * Idempotently lock any currently-published forecast for games whose status
 * indicates the game has started or finished. Returns number of runs locked.
 */
export async function lockForecastsForLiveGames(
  admin: SupabaseClient<any>,
  date: string,
): Promise<number> {
  const { data: games } = await admin
    .from("games")
    .select("id, mlb_game_id, game_status, first_pitch_at")
    .eq("date", date);
  if (!games?.length) return 0;

  const liveGamePks = games
    .filter((g: any) => gameHasStartedOrPastStart(g.game_status, g.first_pitch_at))
    .map((g: any) => g.mlb_game_id);
  if (!liveGamePks.length) return 0;

  const { data: locked, error } = await admin
    .from("forecast_runs")
    .update({ status: "locked", locked_at: new Date().toISOString() })
    .in("game_pk", liveGamePks)
    .eq("status", "published")
    .select("id");
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[forecast.lifecycle] lock failed:", error.message);
    return 0;
  }
  return locked?.length ?? 0;
}
