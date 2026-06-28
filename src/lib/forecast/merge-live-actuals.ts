/**
 * Merge live MLB box-score actuals (from getActualsForDate) into a
 * DiamondScoresPayload. Pregame projections / Diamond Scores are NEVER
 * touched — only the per-row `actual` field is overlaid when the row has
 * an mlb_id and the box score has stats for that player.
 *
 * This is a pure client-side helper so the Forecast Board can compare
 * pregame sim values to live actuals without waiting on a server-side
 * projection_results write path.
 */
import type {
  DiamondScoresPayload,
  DiamondHitterCard,
  DiamondPitcherCard,
  ForecastActuals,
} from "@/lib/projections.functions";
import type {
  ActualsPayload,
  HitterActual,
  PitcherActual,
} from "@/lib/actuals.functions";

function hitterActuals(a: HitterActual | undefined): ForecastActuals | null {
  if (!a) return null;
  return {
    hits: a.H ?? 0,
    ab: null, // MLB feed exposes AB but we don't need it for the board overlay
    total_bases: a.TB ?? 0,
    home_runs: a.HR ?? 0,
    rbis: a.RBI ?? 0,
    stolen_bases: a.SB ?? 0,
    walks: null,
    strikeouts: a.K ?? 0,
    plate_appearances: null,
    runs: a.R ?? 0,
  };
}

function pitcherActuals(a: PitcherActual | undefined): ForecastActuals | null {
  if (!a) return null;
  return {
    hits: a.H ?? 0,
    ab: null,
    total_bases: null,
    home_runs: null,
    rbis: null,
    stolen_bases: null,
    walks: a.BB ?? 0,
    strikeouts: a.K ?? 0,
    plate_appearances: null,
    runs: null,
  };
}

export function mergeLiveActualsIntoDiamondPayload(
  payload: DiamondScoresPayload,
  actuals: ActualsPayload | undefined | null,
): DiamondScoresPayload {
  if (!actuals) return payload;
  const hitters: DiamondHitterCard[] = payload.hitters.map((h) => {
    if (h.actual) return h;
    if (h.mlb_id == null) return h;
    const a = actuals.hitters[String(h.mlb_id)];
    if (!a) return h;
    return { ...h, actual: hitterActuals(a) };
  });
  const pitchers: DiamondPitcherCard[] = payload.pitchers.map((p) => {
    if (p.actual) return p;
    if (p.mlb_id == null) return p;
    const a = actuals.pitchers[String(p.mlb_id)];
    if (!a) return p;
    return { ...p, actual: pitcherActuals(a) };
  });
  return { ...payload, hitters, pitchers };
}
