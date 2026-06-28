import {
  project as projectAlpha03,
  MODEL_VERSION as ALPHA_0_3_VERSION,
  type AlphaEngineInput,
  type AlphaEngineOutput,
} from "./alpha_0_3/engine.ts";
import {
  project as projectV010,
  MODEL_VERSION as V0_1_0_VERSION,
  type EngineInput,
  type EngineOutput,
} from "./v0_1_0/engine.ts";

/**
 * Alpha 0.3.1 — same Alpha 0.3 engine wiring, but with Bayesian small-sample
 * shrinkage applied at the input-profile layer (see src/lib/sim/shrinkage.ts
 * + src/lib/sim.functions.ts). No hitter math changed inside the engine; the
 * version key is used by the registry + DB to roll out new immutable runs.
 *
 * Runs (R) are explicitly unavailable in this version — Alpha credits batter
 * runs only on HR. UI surfaces should hide R for alpha-0.3.1-sample-shrink.
 */
export const ALPHA_0_3_1_VERSION = "alpha-0.3.1-sample-shrink" as const;

export const SUPPORTED_MODEL_VERSIONS = [
  V0_1_0_VERSION,
  ALPHA_0_3_VERSION,
  ALPHA_0_3_1_VERSION,
] as const;
export type SupportedModelVersion = (typeof SUPPORTED_MODEL_VERSIONS)[number];

export const VERSIONS_WITHOUT_RUNS: ReadonlySet<string> = new Set([
  ALPHA_0_3_1_VERSION,
]);

export type VersionedProjectionOutput =
  | (EngineOutput & {
      model_version: typeof V0_1_0_VERSION;
      role: "hitter";
      run_probability: null;
      pitcher_win_probability: null;
      quality_start_probability: null;
      projected_outs: null;
      environment_agreement: null;
      game_environment_inputs: null;
    })
  | AlphaEngineOutput;

export function resolveModelVersion(activeVersion: string | null | undefined, explicitVersion?: string): string {
  return explicitVersion ?? activeVersion ?? V0_1_0_VERSION;
}

export function isAlpha03(version: string): boolean {
  return version === ALPHA_0_3_VERSION || version === ALPHA_0_3_1_VERSION;
}

export function projectForModelVersion(
  version: string,
  input: AlphaEngineInput,
): VersionedProjectionOutput {
  if (version === ALPHA_0_3_VERSION || version === ALPHA_0_3_1_VERSION) {
    return projectAlpha03(input);
  }


  if (version === V0_1_0_VERSION) {
    const out = projectV010(input as EngineInput);
    return {
      ...out,
      model_version: V0_1_0_VERSION,
      role: "hitter",
      run_probability: null,
      pitcher_win_probability: null,
      quality_start_probability: null,
      projected_outs: null,
      environment_agreement: null,
      game_environment_inputs: null,
    };
  }

  throw new Error(`Unsupported Diamond Engine model version: ${version}`);
}

