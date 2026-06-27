/**
 * Resolver: DB + MLB context → MaterialInputs, plus the simulateAndBuild
 * callback that the lifecycle module invokes when (and only when) a new
 * forecast version is warranted.
 *
 * This module is the single bridge between the lifecycle writer and the
 * existing Monte Carlo + engine math. No reads ever import from here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  publishForecastIfEligible,
  type LifecycleContext,
  type LifecycleResult,
  type ForecastClass,
} from "./lifecycle";
import type { MaterialInputs } from "./material-hash";
import { projectForModelVersion } from "@/lib/engines/registry";
import type { MonteCarloGameEnvironment, TeamSide } from "@/lib/game-environment";

type GameRow = {
  id: string;
  mlb_game_id: number;
  date: string;
  game_status: string | null;
  first_pitch_at: string | null;
  home_team_id: string | null;
  away_team_id: string | null;
};

export async function resolveAndPublishForecast(args: {
  admin: SupabaseClient<any>;
  game: GameRow;
  modelVersion: string;
  triggerReason: string;
  actor?: string | null;
  notes?: string | null;
  force?: boolean;
  forecastClass?: ForecastClass;
}): Promise<LifecycleResult> {
  const { admin, game, modelVersion, triggerReason, actor, notes, force, forecastClass } = args;


  // ----- Resolve material inputs from DB -----
  const [{ data: lineups }, { data: sps }, { data: glsRows }] = await Promise.all([
    admin.from("lineups").select("game_id, player_id, team_id, batting_order, lineup_status, confirmed, locked_at").eq("game_id", game.id),
    admin.from("starting_pitchers").select("game_id, team_id, player_id, confirmed").eq("game_id", game.id),
    admin.from("game_lineup_status").select("game_id, status, primary_source, confidence").eq("game_id", game.id),
  ]);

  const gls = glsRows?.[0] ?? null;
  const playerIds = Array.from(new Set([
    ...((lineups ?? []).map((l: any) => l.player_id)),
    ...((sps ?? []).map((s: any) => s.player_id)),
  ]));
  const { data: playerRows } = playerIds.length
    ? await admin.from("players").select("id, mlb_id").in("id", playerIds)
    : { data: [] as any[] };
  const mlbByPlayer = new Map((playerRows ?? []).map((p: any) => [p.id, (p as any).mlb_id ?? null]));

  function lineupConfirmed(l: any): boolean {
    if (l.confirmed === true || l.locked_at != null) return true;
    const s = (l.lineup_status ?? "").toLowerCase();
    if (["locked", "confirmed", "official"].includes(s)) return true;
    const gs = (gls?.status ?? "").toLowerCase();
    return ["locked", "confirmed", "official"].includes(gs);
  }

  function buildLineupForTeam(teamId: string | null): Array<{ mlbId: number; order: number }> {
    if (!teamId) return [];
    const rows = (lineups ?? []).filter((l: any) => l.team_id === teamId && lineupConfirmed(l));
    const out: Array<{ mlbId: number; order: number }> = [];
    for (const l of rows) {
      const mlb = mlbByPlayer.get(l.player_id);
      if (mlb && l.batting_order) out.push({ mlbId: mlb, order: l.batting_order });
    }
    // Dedupe by order; keep first 9.
    const byOrder = new Map<number, { mlbId: number; order: number }>();
    for (const r of out.sort((a, b) => a.order - b.order)) {
      if (!byOrder.has(r.order)) byOrder.set(r.order, r);
    }
    return Array.from(byOrder.values()).slice(0, 9);
  }

  function spForTeam(teamId: string | null): { playerId: string; mlbId: number } | null {
    if (!teamId) return null;
    const sp = (sps ?? []).find((s: any) => s.team_id === teamId && s.confirmed === true);
    if (!sp) return null;
    const m = mlbByPlayer.get(sp.player_id);
    return m ? { playerId: sp.player_id, mlbId: m } : null;
  }

  const homeSp = spForTeam(game.home_team_id);
  const awaySp = spForTeam(game.away_team_id);
  const homeLineup = buildLineupForTeam(game.home_team_id);
  const awayLineup = buildLineupForTeam(game.away_team_id);

  const candidateInputs: Partial<MaterialInputs> = {
    gamePk: game.mlb_game_id,
    modelVersion,
    homeStarterMlbId: homeSp?.mlbId,
    awayStarterMlbId: awaySp?.mlbId,
    homeLineup,
    awayLineup,
    venueId: null,
    parkFactors: null,
    gameEnvironment: null,
  };

  // ----- simulateAndBuild callback -----
  const ctx: LifecycleContext = {
    admin,
    simulateAndBuild: async ({ inputs, seed, gameId }) => {
      const { buildMonteCarloGameEnvironmentWithSeed } = await import("@/lib/sim.functions");
      const { gameEnvironment, result, venueId } = await buildMonteCarloGameEnvironmentWithSeed(
        inputs.gamePk,
        seed,
      );
      // Annotate inputs with environment actually used so the hash captures it on next call.
      (inputs as any).venueId = venueId;
      (inputs as any).gameEnvironment = gameEnvironment as unknown as Record<string, unknown>;

      // DNA lookup for every player in lineups + pitchers
      const allPlayerIds = Array.from(
        new Set([...playerIds]),
      );
      const { data: dnaRows } = allPlayerIds.length
        ? await admin.from("player_dna").select("*").in("player_id", allPlayerIds)
        : { data: [] as any[] };
      const dnaByPlayer = new Map((dnaRows ?? []).map((d: any) => [d.player_id, d]));

      const sideForTeam = (teamId: string | null): TeamSide =>
        teamId === game.home_team_id ? "home" : "away";

      const { snapshotResultToDistributions, buildHitterSnapshot, buildPitcherSnapshot } =
        await import("@/lib/sim-snapshot");
      const dists = snapshotResultToDistributions(result);
      const SNAPSHOT_ITERATIONS = 2000;

      const out: Array<any> = [];

      // Hitters
      for (const l of lineups ?? []) {
        if (!lineupConfirmed(l)) continue;
        const dna = dnaByPlayer.get(l.player_id) ?? {
          contact: 50, power: 50, speed: 50, discipline: 50, consistency: 50,
        };
        const oppTeam = l.team_id === game.home_team_id ? game.away_team_id : game.home_team_id;
        const oppSp = oppTeam === game.home_team_id ? homeSp : awaySp;
        const oppDna = oppSp ? dnaByPlayer.get(oppSp.playerId) : null;
        const pitcherQuality = oppDna ? 100 - (Number(oppDna.contact) || 50) : 50;

        const proj = projectForModelVersion(inputs.modelVersion, {
          dna: {
            contact: Number(dna.contact), power: Number(dna.power),
            speed: Number(dna.speed), discipline: Number(dna.discipline),
            consistency: Number(dna.consistency),
          },
          pitcherQuality,
          battingOrder: l.batting_order,
          teamSide: sideForTeam(l.team_id),
          role: "hitter",
          gameEnvironment: gameEnvironment as MonteCarloGameEnvironment,
        });

        const mlbId = mlbByPlayer.get(l.player_id) ?? null;
        const dist = mlbId != null ? dists.hittersByMlbId.get(mlbId) : undefined;
        const snap = dist
          ? buildHitterSnapshot({
              dist,
              game_id: gameId,
              game_pk: inputs.gamePk,
              player_id: l.player_id,
              mlb_id: mlbId,
              model_version: inputs.modelVersion,
              iterations: SNAPSHOT_ITERATIONS,
            })
          : null;

        out.push({
          player_id: l.player_id,
          mlb_id: mlbId,
          role: "hitter",
          diamond_score: proj.diamond_score,
          confidence: proj.confidence,
          contact_score: proj.contact_score,
          power_score: proj.power_score,
          speed_score: proj.speed_score,
          pitcher_grade: proj.pitcher_grade,
          matchup_grade: proj.matchup_grade,
          hit_probability: proj.hit_probability,
          total_base_probability: proj.total_base_probability,
          hr_probability: proj.hr_probability,
          rbi_probability: proj.rbi_probability,
          sb_probability: proj.sb_probability,
          run_probability: proj.run_probability,
          pitcher_win_probability: null,
          quality_start_probability: null,
          projected_outs: null,
          environment_agreement: proj.environment_agreement,
          distributions: snap?.distributions ?? null,
          inputs: proj.inputs as Record<string, unknown>,
        });
      }

      // Pitchers (always Alpha 0.3 pitcher math regardless of active hitter version)
      const { project: projectPitcherAlpha } = await import("@/lib/engines/alpha_0_3/engine");
      for (const sp of sps ?? []) {
        if (sp.confirmed !== true) continue;
        const dna = dnaByPlayer.get(sp.player_id) ?? {
          contact: 50, power: 50, speed: 35, discipline: 50, consistency: 50,
        };
        const proj = projectPitcherAlpha({
          role: "pitcher",
          teamSide: sideForTeam(sp.team_id),
          gameEnvironment: gameEnvironment as MonteCarloGameEnvironment,
          dna: {
            contact: Number(dna.contact), power: Number(dna.power),
            speed: Number(dna.speed), discipline: Number(dna.discipline),
            consistency: Number(dna.consistency),
          },
          pitcherQuality: 100 - (Number(dna.contact) || 50),
        });
        const mlbId = mlbByPlayer.get(sp.player_id) ?? null;
        const dist = mlbId != null ? dists.pitcherByMlbId.get(mlbId) : undefined;
        const snap = dist
          ? buildPitcherSnapshot({
              dist,
              game_id: gameId,
              game_pk: inputs.gamePk,
              player_id: sp.player_id,
              mlb_id: mlbId,
              model_version: inputs.modelVersion,
              iterations: SNAPSHOT_ITERATIONS,
            })
          : null;
        out.push({
          player_id: sp.player_id,
          mlb_id: mlbId,
          role: "pitcher",
          diamond_score: proj.diamond_score,
          confidence: proj.confidence,
          contact_score: proj.contact_score,
          power_score: proj.power_score,
          speed_score: proj.speed_score,
          pitcher_grade: proj.pitcher_grade,
          matchup_grade: proj.matchup_grade,
          hit_probability: proj.hit_probability,
          total_base_probability: proj.total_base_probability,
          hr_probability: proj.hr_probability,
          rbi_probability: proj.rbi_probability,
          sb_probability: proj.sb_probability,
          run_probability: proj.run_probability,
          pitcher_win_probability: proj.pitcher_win_probability,
          quality_start_probability: proj.quality_start_probability,
          projected_outs: proj.projected_outs,
          environment_agreement: proj.environment_agreement,
          distributions: snap?.distributions ?? null,
          inputs: proj.inputs as Record<string, unknown>,
        });
      }

      return { projections: out };
    },
  };

  return publishForecastIfEligible(ctx, {
    gamePk: game.mlb_game_id,
    modelVersion,
    triggerReason,
    actor: actor ?? null,
    notes: notes ?? null,
    force: force ?? false,
    forecastClass: forecastClass ?? "official",
    candidateInputs,
    game: {
      id: game.id,
      mlb_game_id: game.mlb_game_id,
      date: game.date,
      game_status: game.game_status,
      first_pitch_at: game.first_pitch_at,
    },
  });
}

