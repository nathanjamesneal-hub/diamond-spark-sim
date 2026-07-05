import { createHash } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  adjustBatterProfileForRecentForm,
  adjustPitcherProfileForRecentForm,
  type FormAdjustmentMetadata,
  type RecentEventCounts,
} from "./adjustment";
import { readRecentEventCounts } from "./recent-events";

const MODEL_VERSION = "diamond-v2-form-shadow-0.1";
const FORM_WINDOW_DAYS = 14;
const SHADOW_ITERATIONS = 2000;

export type FormShadowResult = {
  ok: boolean;
  shadowRunId: string | null;
  forecastRunId: string;
  gamePk: number | null;
  playersWritten: number;
  adjustmentsApplied: number;
  error?: string;
};

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function adjustmentKey(role: "hitter" | "pitcher", mlbId: number): string {
  return `${role}:${mlbId}`;
}

function recentKey(role: "hitter" | "pitcher", mlbId: number): string {
  return `${mlbId}:${role}`;
}

export async function runFormShadowForForecastRun(
  admin: any,
  forecastRunId: string,
  windowDays = FORM_WINDOW_DAYS,
): Promise<FormShadowResult> {
  const { data: run, error: runError } = await admin
    .from("forecast_runs")
    .select("id, game_id, game_pk, slate_date, model_version, status, projection_class, simulation_seed, input_hash")
    .eq("id", forecastRunId)
    .maybeSingle();
  if (runError) throw new Error(runError.message);
  if (!run) return { ok: false, shadowRunId: null, forecastRunId, gamePk: null, playersWritten: 0, adjustmentsApplied: 0, error: "forecast run not found" };
  if (run.projection_class !== "official") {
    return { ok: true, shadowRunId: null, forecastRunId, gamePk: Number(run.game_pk), playersWritten: 0, adjustmentsApplied: 0 };
  }

  const seed = Number(run.simulation_seed);
  if (!Number.isFinite(seed)) {
    return { ok: false, shadowRunId: null, forecastRunId, gamePk: Number(run.game_pk), playersWritten: 0, adjustmentsApplied: 0, error: "missing deterministic simulation seed" };
  }

  const { data: baselineRows, error: fppError } = await admin
    .from("forecast_player_projections")
    .select("player_id, mlb_id, role, distributions")
    .eq("forecast_run_id", forecastRunId);
  if (fppError) throw new Error(fppError.message);

  const mlbIds = (baselineRows ?? []).map((row: any) => Number(row.mlb_id)).filter(Boolean);
  const recentByKey = await readRecentEventCounts(admin, String(run.slate_date), windowDays, mlbIds);
  const adjustments = new Map<string, FormAdjustmentMetadata>();

  const { buildMonteCarloGameEnvironmentWithSeedAndProfileAdjuster } = await import("@/lib/sim.functions");
  const { snapshotResultToDistributions } = await import("@/lib/sim-snapshot");

  const adjusted = await buildMonteCarloGameEnvironmentWithSeedAndProfileAdjuster(
    Number(run.game_pk),
    seed,
    ({ homeLineup, awayLineup, homeStarter, awayStarter }) => {
      const adjustHitter = (profile: typeof homeLineup[number]) => {
        const recent = recentByKey.get(recentKey("hitter", profile.id));
        const result = adjustBatterProfileForRecentForm(profile, recent);
        adjustments.set(adjustmentKey("hitter", profile.id), result.metadata);
        return result.profile;
      };
      const adjustPitcher = (profile: typeof homeStarter) => {
        const recent = recentByKey.get(recentKey("pitcher", profile.id)) as RecentEventCounts | undefined;
        const result = adjustPitcherProfileForRecentForm(profile, recent);
        adjustments.set(adjustmentKey("pitcher", profile.id), result.metadata);
        return result.profile;
      };
      return {
        homeLineup: homeLineup.map(adjustHitter),
        awayLineup: awayLineup.map(adjustHitter),
        homeStarter: adjustPitcher(homeStarter),
        awayStarter: adjustPitcher(awayStarter),
        metadata: {
          modelVersion: MODEL_VERSION,
          windowDays,
          adjustments: Object.fromEntries(adjustments),
        },
      };
    },
  );

  const dists = snapshotResultToDistributions(adjusted.result);
  const inputHash = hash({
    modelVersion: MODEL_VERSION,
    baselineForecastRunId: forecastRunId,
    baselineInputHash: run.input_hash,
    seed,
    iterations: SHADOW_ITERATIONS,
    formWindowDays: windowDays,
    formAdjustments: Object.fromEntries(adjustments),
  });

  const { data: shadowRun, error: shadowRunError } = await admin
    .from("monte_carlo_form_shadow_runs")
    .upsert({
      game_id: run.game_id,
      game_pk: run.game_pk,
      slate_date: run.slate_date,
      baseline_forecast_run_id: forecastRunId,
      model_version: MODEL_VERSION,
      seed,
      iterations: SHADOW_ITERATIONS,
      form_window_days: windowDays,
      input_hash: inputHash,
    }, { onConflict: "baseline_forecast_run_id,model_version,form_window_days" })
    .select("id")
    .maybeSingle();
  if (shadowRunError) throw new Error(shadowRunError.message);
  const shadowRunId = shadowRun?.id ?? null;
  if (!shadowRunId) throw new Error("shadow run upsert returned no id");

  const playerIds = (baselineRows ?? []).map((row: any) => row.player_id).filter(Boolean);
  const { data: actualRows } = playerIds.length
    ? await admin
        .from("projection_results")
        .select("*")
        .eq("game_id", run.game_id)
        .in("player_id", playerIds)
    : { data: [] };
  const actualByPlayer = new Map((actualRows ?? []).map((row: any) => [row.player_id, row]));

  const outputRows = (baselineRows ?? []).map((row: any) => {
    const mlbId = Number(row.mlb_id);
    const role = row.role as "hitter" | "pitcher";
    const formDist = role === "hitter"
      ? dists.hittersByMlbId.get(mlbId)
      : dists.pitcherByMlbId.get(mlbId);
    const meta = adjustments.get(adjustmentKey(role, mlbId)) ?? null;
    return {
      shadow_run_id: shadowRunId,
      player_id: row.player_id,
      mlb_id: row.mlb_id,
      role,
      baseline_distributions: row.distributions ?? null,
      form_distributions: formDist ?? null,
      form_adjustments: meta,
      actuals: actualByPlayer.get(row.player_id) ?? null,
    };
  });

  if (outputRows.length) {
    const { error } = await admin
      .from("monte_carlo_form_shadow_player_outputs")
      .upsert(outputRows, { onConflict: "shadow_run_id,player_id,role" });
    if (error) throw new Error(error.message);
  }

  const adjustmentsApplied = Array.from(adjustments.values()).filter((m) => m.applied).length;
  return {
    ok: true,
    shadowRunId,
    forecastRunId,
    gamePk: Number(run.game_pk),
    playersWritten: outputRows.length,
    adjustmentsApplied,
  };
}

export const runFormShadowForForecast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { forecastRunId: string; windowDays?: number }) => data)
  .handler(async ({ data, context }): Promise<FormShadowResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    try {
      return await runFormShadowForForecastRun(
        supabaseAdmin as any,
        data.forecastRunId,
        data.windowDays ?? FORM_WINDOW_DAYS,
      );
    } catch (e: any) {
      return {
        ok: false,
        shadowRunId: null,
        forecastRunId: data.forecastRunId,
        gamePk: null,
        playersWritten: 0,
        adjustmentsApplied: 0,
        error: e?.message ?? String(e),
      };
    }
  });
