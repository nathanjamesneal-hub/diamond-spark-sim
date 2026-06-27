import { gameHasStartedOrPastStart } from "./window";

export type PublicProjectionClass = "official" | "preview";
export type PublicRunStatus = "locked" | "published" | string;

export type PublicForecastRunCandidate = {
  id: string | null;
  game_id: string;
  model_version: string;
  projection_class: PublicProjectionClass | string;
  status: PublicRunStatus | null;
  locked_at?: string | null;
  generated_at?: string | null;
};

export type PublicProjectionCandidate = {
  player_id: string;
  game_id: string;
  model_version: string;
  projection_class: PublicProjectionClass | string;
  projection_role?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
};

export type SelectedPublicForecastCandidate<TProjection extends PublicProjectionCandidate = PublicProjectionCandidate> = {
  projection: TProjection;
  run: PublicForecastRunCandidate;
  projectionClass: PublicProjectionClass;
};

function statusRank(status: string | null | undefined): number {
  if (status === "locked") return 2;
  if (status === "published") return 1;
  return 0;
}

function timeValue(v: string | null | undefined): number {
  if (!v) return 0;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

function roleOf(v: string | null | undefined): "hitter" | "pitcher" {
  return v === "pitcher" ? "pitcher" : "hitter";
}

function bestRun(
  runs: PublicForecastRunCandidate[],
  gameId: string,
  modelVersion: string,
  projectionClass: PublicProjectionClass,
): PublicForecastRunCandidate | null {
  const candidates = runs
    .filter((r) =>
      r.game_id === gameId &&
      r.model_version === modelVersion &&
      r.projection_class === projectionClass &&
      (r.status === "locked" || r.status === "published") &&
      r.id,
    )
    .sort((a, b) => {
      const sr = statusRank(b.status) - statusRank(a.status);
      if (sr !== 0) return sr;
      return timeValue(b.locked_at ?? b.generated_at) - timeValue(a.locked_at ?? a.generated_at);
    });
  return candidates[0] ?? null;
}

function bestProjection<TProjection extends PublicProjectionCandidate>(
  projections: TProjection[],
  playerId: string,
  gameId: string,
  role: "hitter" | "pitcher",
  modelVersion: string,
  projectionClass: PublicProjectionClass,
): TProjection | null {
  return projections
    .filter((p) =>
      p.player_id === playerId &&
      p.game_id === gameId &&
      p.model_version === modelVersion &&
      p.projection_class === projectionClass &&
      roleOf(p.projection_role) === role,
    )
    .sort((a, b) => timeValue(b.created_at) - timeValue(a.created_at))[0] ?? null;
}

/**
 * Best available public forecast selector.
 *
 * Priority is intentionally fixed: locked official → published official →
 * pregame preview. It returns only a projection/run pair from the same
 * game/version/class; callers then attach exact-run FPP distributions and that
 * selected projection's sim_snapshot before invoking getMarketSimulationMetrics.
 */
export function selectBestPublicForecast<TProjection extends PublicProjectionCandidate>(args: {
  playerId: string;
  gameId: string;
  role: "hitter" | "pitcher";
  modelVersion: string;
  gameStatus?: string | null;
  firstPitchAt?: string | null;
  runs: PublicForecastRunCandidate[];
  projections: TProjection[];
  now?: number;
}): SelectedPublicForecastCandidate<TProjection> | null {
  const officialProjection = bestProjection(args.projections, args.playerId, args.gameId, args.role, args.modelVersion, "official");
  if (officialProjection) {
    const officialRun = bestRun(args.runs, args.gameId, args.modelVersion, "official");
    if (officialRun) return { projection: officialProjection, run: officialRun, projectionClass: "official" };
  }

  const previewProjection = bestProjection(args.projections, args.playerId, args.gameId, args.role, args.modelVersion, "preview");
  if (previewProjection) {
    const previewRun = bestRun(args.runs, args.gameId, args.modelVersion, "preview");
    if (previewRun) {
      const started = gameHasStartedOrPastStart(args.gameStatus, args.firstPitchAt, args.now);
      // Post-first-pitch: only accept a locked preview snapshot (immutable
      // pregame projection frozen by the lock-live cron). Pregame: accept
      // either locked or published preview.
      if (!started || previewRun.status === "locked") {
        return { projection: previewProjection, run: previewRun, projectionClass: "preview" };
      }
    }
  }

  return null;
}

