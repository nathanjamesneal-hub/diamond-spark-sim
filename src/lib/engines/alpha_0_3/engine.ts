/**
 * Diamond Engine Alpha 0.3.
 *
 * v0.1.0 remains intact. Alpha 0.3 wraps the baseline hitter projection and
 * lets the Monte Carlo Game Environment Engine influence run/RBI context,
 * pitcher outcomes, and confidence.
 */
import {
  project as projectV010,
  type DnaRatings,
  type EngineInput,
  type EngineOutput,
} from "../v0_1_0/engine.ts";
import {
  opponentRunsForEnvironment,
  starterDistributionsForEnvironment,
  teamRunsForEnvironment,
  teamWinProbabilityForEnvironment,
  type GameEnvironmentInput,
  type TeamSide,
} from "../../game-environment.ts";

export type AlphaRole = "hitter" | "pitcher";

export type AlphaEngineInput = EngineInput & {
  role?: AlphaRole;
  teamSide?: TeamSide;
  gameEnvironment?: GameEnvironmentInput;
};

export type AlphaEngineOutput = EngineOutput & {
  model_version: typeof MODEL_VERSION;
  role: AlphaRole;
  run_probability: number | null;
  pitcher_win_probability: number | null;
  quality_start_probability: number | null;
  projected_outs: number | null;
  environment_agreement: number | null;
  game_environment_inputs: {
    projected_team_runs: number | null;
    projected_opponent_runs: number | null;
    team_win_probability: number | null;
    run_environment_rating: number | null;
  };
};

const LEAGUE_TEAM_RUNS = 4.3;

const RBI_SPOT_FACTOR: Record<number, number> = {
  1: 0.76,
  2: 0.9,
  3: 1.12,
  4: 1.22,
  5: 1.14,
  6: 1.02,
  7: 0.9,
  8: 0.82,
  9: 0.76,
};

const RUN_SPOT_FACTOR: Record<number, number> = {
  1: 1.22,
  2: 1.16,
  3: 1.08,
  4: 1.02,
  5: 0.98,
  6: 0.92,
  7: 0.86,
  8: 0.82,
  9: 0.78,
};

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const clampProb = (v: number) => Math.max(0, Math.min(0.98, v));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function project(input: AlphaEngineInput): AlphaEngineOutput {
  const role = input.role ?? "hitter";
  const teamSide = input.teamSide ?? "home";
  const base = projectV010(input);

  const projectedTeamRuns = teamRunsForEnvironment(input.gameEnvironment, teamSide);
  const projectedOpponentRuns = opponentRunsForEnvironment(input.gameEnvironment, teamSide);
  const teamWinProbability = teamWinProbabilityForEnvironment(input.gameEnvironment, teamSide);
  const runEnvironmentRating = input.gameEnvironment?.runEnvironmentRating ?? null;

  if (role === "pitcher") {
    return projectPitcher({
      input,
      base,
      teamSide,
      projectedTeamRuns,
      projectedOpponentRuns,
      teamWinProbability,
      runEnvironmentRating,
    });
  }

  return projectHitter({
    input,
    base,
    projectedTeamRuns,
    projectedOpponentRuns,
    teamWinProbability,
    runEnvironmentRating,
  });
}

function projectHitter(args: {
  input: AlphaEngineInput;
  base: EngineOutput;
  projectedTeamRuns: number | null;
  projectedOpponentRuns: number | null;
  teamWinProbability: number | null;
  runEnvironmentRating: number | null;
}): AlphaEngineOutput {
  const { input, base, projectedTeamRuns, projectedOpponentRuns, teamWinProbability, runEnvironmentRating } = args;
  const battingOrder = input.battingOrder ?? 5;
  const teamRunFactor = projectedTeamRuns == null ? 1 : clamp(projectedTeamRuns / LEAGUE_TEAM_RUNS, 0.55, 1.65);

  const rbi_probability = projectedTeamRuns == null
    ? base.rbi_probability
    : round3(clampProb(base.rbi_probability * teamRunFactor * (RBI_SPOT_FACTOR[battingOrder] ?? 1)));

  const runBase = 0.12 + base.hit_probability * 0.42 + base.hr_probability * 0.55;
  const run_probability = round3(
    clampProb(runBase * teamRunFactor * (RUN_SPOT_FACTOR[battingOrder] ?? 1)),
  );

  const environmentAgreement = projectedTeamRuns == null
    ? null
    : agreementScore(base, projectedTeamRuns);
  const confidence = clamp(
    Math.round(base.confidence + confidenceDelta(environmentAgreement)),
  );

  const environmentScoreDelta = projectedTeamRuns == null
    ? 0
    : (teamRunFactor - 1) * 8 + (environmentAgreement ?? 0) * 3;

  return {
    ...base,
    model_version: MODEL_VERSION,
    role: "hitter",
    diamond_score: Math.round(clamp(base.diamond_score + environmentScoreDelta)),
    rbi_probability,
    run_probability,
    confidence,
    pitcher_win_probability: null,
    quality_start_probability: null,
    projected_outs: null,
    environment_agreement: environmentAgreement == null ? null : round3(environmentAgreement),
    game_environment_inputs: {
      projected_team_runs: projectedTeamRuns,
      projected_opponent_runs: projectedOpponentRuns,
      team_win_probability: teamWinProbability,
      run_environment_rating: runEnvironmentRating,
    },
  };
}

function projectPitcher(args: {
  input: AlphaEngineInput;
  base: EngineOutput;
  teamSide: TeamSide;
  projectedTeamRuns: number | null;
  projectedOpponentRuns: number | null;
  teamWinProbability: number | null;
  runEnvironmentRating: number | null;
}): AlphaEngineOutput {
  const { input, base, teamSide, projectedTeamRuns, projectedOpponentRuns, teamWinProbability, runEnvironmentRating } = args;
  const starter = starterDistributionsForEnvironment(input.gameEnvironment, teamSide);
  const projectedOuts = starter?.outs.mean ?? projectedOutsFromEnvironment(runEnvironmentRating);
  const opponentRuns = projectedOpponentRuns ?? LEAGUE_TEAM_RUNS;
  const winProbability = teamWinProbability == null
    ? null
    : round3(clampProb(teamWinProbability * clamp(projectedOuts / 16, 0.65, 1.08)));
  const qualityStartProbability = round3(
    clampProb(0.42 + (projectedOuts - 18) * 0.055 + (4 - opponentRuns) * 0.08),
  );
  const confidence = clamp(
    Math.round(base.confidence + (starter ? 8 : -4) - Math.max(0, (runEnvironmentRating ?? 50) - 65) * 0.25),
  );

  return {
    ...base,
    model_version: MODEL_VERSION,
    role: "pitcher",
    diamond_score: Math.round(clamp(base.diamond_score + (winProbability == null ? 0 : (winProbability - 0.5) * 12))),
    confidence,
    run_probability: null,
    pitcher_win_probability: winProbability,
    quality_start_probability: qualityStartProbability,
    projected_outs: round3(projectedOuts),
    environment_agreement: null,
    game_environment_inputs: {
      projected_team_runs: projectedTeamRuns,
      projected_opponent_runs: projectedOpponentRuns,
      team_win_probability: teamWinProbability,
      run_environment_rating: runEnvironmentRating,
    },
  };
}

function projectedOutsFromEnvironment(runEnvironmentRating: number | null): number {
  if (runEnvironmentRating == null) return 16.5;
  return clamp(18 - (runEnvironmentRating - 50) * 0.045, 12, 21);
}

function agreementScore(base: EngineOutput, projectedTeamRuns: number): number {
  const modelSignal = (base.rbi_probability - 0.28) * 1.7 + (base.total_base_probability - 0.45) * 0.8;
  const environmentSignal = (projectedTeamRuns - LEAGUE_TEAM_RUNS) / LEAGUE_TEAM_RUNS;
  const sameDirection = Math.sign(modelSignal) === Math.sign(environmentSignal);
  const distance = Math.min(1, Math.abs(modelSignal - environmentSignal));
  return sameDirection ? 1 - distance : -distance;
}

function confidenceDelta(agreement: number | null): number {
  if (agreement == null) return 0;
  return agreement >= 0 ? agreement * 10 : agreement * 14;
}

export const MODEL_VERSION = "alpha-0.3";

export type { DnaRatings };
