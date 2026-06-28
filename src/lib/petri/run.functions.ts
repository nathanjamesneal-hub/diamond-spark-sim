/**
 * Petri v0.2 Shadow Lab — server functions.
 *
 * Petri auto-runs from the same Alpha ingest/orchestrator workflow. The admin
 * button (`runPetriShadowForUnstarted`) is a manual retry shortcut and calls
 * the same pipeline.
 *
 * Hooks into existing Alpha primitives:
 *   - `aggregateLineups` / `runRefresh` (lineup + starter ingest)
 *   - `gameHasStartedOrPastStart` (first-pitch guard, shared with Alpha)
 *   - `orchestrateDiamondSlate` (cron orchestrator)
 *
 * Lifecycle per game per slate:
 *   PREVIEW  — projected lineup + probable starters present (any confirmed flag)
 *   OFFICIAL — both starters CONFIRMED + complete 1–9 batting orders both teams
 *   LOCKED   — first pitch reached for the newest valid OFFICIAL run
 *   SUPERSEDED — older active run replaced by a newer one with different inputs
 *
 * Idempotency: `(game_id, model_version, projection_class, input_hash)` over
 * status ∈ {preview, locked} is unique. Re-running with identical inputs is a
 * no-op. Re-running with different inputs supersedes the older active run.
 *
 * Petri tables (`petri_forecast_runs`, `petri_player_market_snapshots`,
 * `petri_skill_profiles`) are isolated from Alpha. Alpha tables/selectors are
 * never touched here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { todayInAppTz } from "@/lib/timezone";
import { gameHasStartedOrPastStart } from "@/lib/forecast/window";
import {
  simulate,
  summarize,
  type PetriSimResult,
} from "./engine";
import {
  buildPetriTeam,
  computeCompleteness,
  petriParkFactor,
  type DnaRow,
  type SourceMap,
} from "./inputs";
import { inputHash, seedFromHash } from "./hash";
import {
  buildHitterSkillProfile,
  buildPitcherSkillProfile,
  profileToOutcomeRates,
  toEnginePARates,
  PETRI_SKILL_PROFILE_VERSION,
  type HitterSkillProfile,
  type PitcherSkillProfile,
} from "./skill-profile";

const ITERATIONS = 10000;
const MODEL_VERSION = "petri-v0.2-shadow";

async function ensureAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin only");
}

export type PetriClass = "preview" | "official";

export type PetriPipelineSummary = {
  date: string;
  intendedClass: PetriClass;
  eligibleGames: number;
  generated: number;
  noChange: Array<{ mlb_game_id: number; matchup: string; reason: string }>;
  superseded: number;
  abstained: Array<{ mlb_game_id: number; matchup: string; reason: string }>;
  skipped: Array<{ mlb_game_id: number; matchup: string; reason: string }>;
  hitterSnapshots: number;
  pitcherSnapshots: number;
};

export type PetriRunSummary = {
  date: string;
  eligibleGames: number;
  generated: number;
  abstained: Array<{ mlb_game_id: number; matchup: string; reason: string }>;
  skipped: Array<{ mlb_game_id: number; matchup: string; reason: string }>;
  locked: number;
  hitterSnapshots: number;
  pitcherSnapshots: number;
  durationMs: number;
  preview?: PetriPipelineSummary;
  official?: PetriPipelineSummary;
};

/**
 * Lock pass — flips any active (`status='preview'`) Petri run whose game
 * has reached first pitch to `status='locked'`. Idempotent. Applies to both
 * preview-class and official-class runs (snapshot freeze). Downstream grading
 * filters on `projection_class='official'` to only grade officials.
 */
export async function lockPetriForecastsAtFirstPitch(
  supabaseAdmin: SupabaseClient,
  date: string,
): Promise<number> {
  const { data: openRuns } = await supabaseAdmin
    .from("petri_forecast_runs")
    .select("id, game_id")
    .eq("status", "preview")
    .eq("game_date", date);
  if (!openRuns || openRuns.length === 0) return 0;

  const gids = Array.from(new Set(openRuns.map((r: any) => r.game_id)));
  const { data: gRows } = await supabaseAdmin
    .from("games")
    .select("id, game_status, first_pitch_at")
    .in("id", gids);

  const startedIds = new Set(
    (gRows ?? [])
      .filter((g: any) => gameHasStartedOrPastStart(g.game_status, g.first_pitch_at))
      .map((g: any) => g.id),
  );
  const ids = openRuns.filter((r: any) => startedIds.has(r.game_id)).map((r: any) => r.id);
  if (ids.length === 0) return 0;

  await supabaseAdmin
    .from("petri_forecast_runs")
    .update({ status: "locked", locked_at: new Date().toISOString() })
    .in("id", ids);
  return ids.length;
}

/**
 * Core Petri pipeline — one pass over today's games for a single intended
 * projection class (preview OR official). Idempotent and class-isolated.
 *
 * Eligibility:
 *   - preview  : 9-slot home + away lineups present, both starter rows present
 *                (confirmed flag NOT required)
 *   - official : 9-slot home + away lineups present, both starters CONFIRMED
 *
 * Idempotency:
 *   - Computes a lightweight `input_hash` BEFORE simulating.
 *   - If an active (preview|locked) run for the same (game, class) already has
 *     this exact hash, returns no-op for that game.
 *   - If an active preview-status run exists with a different hash, marks it
 *     `superseded` and proceeds. Locked runs are immutable and skip.
 */
export async function runPetriPipeline(
  supabaseAdmin: SupabaseClient,
  opts: { date: string; intendedClass: PetriClass; gameIds?: string[] },
): Promise<PetriPipelineSummary> {
  const { date, intendedClass } = opts;

  const summary: PetriPipelineSummary = {
    date,
    intendedClass,
    eligibleGames: 0,
    generated: 0,
    noChange: [],
    superseded: 0,
    abstained: [],
    skipped: [],
    hitterSnapshots: 0,
    pitcherSnapshots: 0,
  };

  // Load games for the date (optionally narrowed)
  let gameQuery = supabaseAdmin
    .from("games")
    .select(
      "id, mlb_game_id, date, game_status, first_pitch_at, ballpark, home_team_id, away_team_id",
    )
    .eq("date", date);
  if (opts.gameIds && opts.gameIds.length > 0) {
    gameQuery = gameQuery.in("id", opts.gameIds);
  }
  const { data: games, error: gErr } = await gameQuery;
  if (gErr) throw new Error(gErr.message);
  if (!games || games.length === 0) return summary;

  const teamIds = Array.from(
    new Set(games.flatMap((g) => [g.home_team_id, g.away_team_id]).filter(Boolean) as string[]),
  );
  const gameIds = games.map((g) => g.id);

  const { data: teams } = await supabaseAdmin
    .from("teams")
    .select("id, mlb_team_id, abbreviation")
    .in("id", teamIds.length ? teamIds : ["00000000-0000-0000-0000-000000000000"]);
  const teamById = new Map((teams ?? []).map((t) => [t.id, t]));

  const { data: lineups } = await supabaseAdmin
    .from("lineups")
    .select("game_id, player_id, team_id, batting_order, lineup_status, confirmed")
    .in("game_id", gameIds);

  const { data: starters } = await supabaseAdmin
    .from("starting_pitchers")
    .select("game_id, team_id, player_id, confirmed")
    .in("game_id", gameIds);

  const playerUuids = Array.from(
    new Set([
      ...(lineups ?? []).map((l) => l.player_id),
      ...(starters ?? []).map((s) => s.player_id),
    ]),
  );

  const { data: players } = playerUuids.length
    ? await supabaseAdmin
        .from("players")
        .select("id, mlb_id, name, team_id, bats, throws")
        .in("id", playerUuids)
    : { data: [] as any[] };
  const playerByUuid = new Map((players ?? []).map((p) => [p.id, p]));

  const { data: dnaRows } = playerUuids.length
    ? await supabaseAdmin
        .from("player_dna")
        .select("player_id, contact, power, discipline, speed, consistency")
        .in("player_id", playerUuids)
    : { data: [] as any[] };
  const dnaByUuid = new Map<string, DnaRow>(
    (dnaRows ?? []).map((r: any) => [
      r.player_id,
      {
        player_id: r.player_id,
        contact: Number(r.contact),
        power: Number(r.power),
        discipline: Number(r.discipline),
        speed: Number(r.speed),
        consistency: Number(r.consistency),
      },
    ]),
  );

  for (const g of games) {
    const homeTeam = g.home_team_id ? teamById.get(g.home_team_id) : null;
    const awayTeam = g.away_team_id ? teamById.get(g.away_team_id) : null;
    const matchup = `${awayTeam?.abbreviation ?? "?"}@${homeTeam?.abbreviation ?? "?"}`;

    // First-pitch guard — shared with Alpha. Petri NEVER runs against live games.
    if (gameHasStartedOrPastStart(g.game_status, g.first_pitch_at)) {
      summary.skipped.push({
        mlb_game_id: g.mlb_game_id,
        matchup,
        reason: `game already started (${g.game_status ?? "unknown"})`,
      });
      continue;
    }

    const sources: SourceMap = {};
    const fallbacks: Array<{ path: string; source: string; reason: string; confidence_impact: string }> = [];
    const abstentionReasons: string[] = [];

    const homeLineup = (lineups ?? [])
      .filter((l) => l.game_id === g.id && l.team_id === g.home_team_id)
      .filter((l) => l.batting_order >= 1 && l.batting_order <= 9);
    const awayLineup = (lineups ?? [])
      .filter((l) => l.game_id === g.id && l.team_id === g.away_team_id)
      .filter((l) => l.batting_order >= 1 && l.batting_order <= 9);

    const homeStarterRow = (starters ?? []).find(
      (s) => s.game_id === g.id && s.team_id === g.home_team_id,
    );
    const awayStarterRow = (starters ?? []).find(
      (s) => s.game_id === g.id && s.team_id === g.away_team_id,
    );

    // Class-specific eligibility.
    if (homeLineup.length !== 9) abstentionReasons.push(`home lineup has ${homeLineup.length}/9 slots`);
    if (awayLineup.length !== 9) abstentionReasons.push(`away lineup has ${awayLineup.length}/9 slots`);
    if (intendedClass === "official") {
      if (!homeStarterRow || !homeStarterRow.confirmed) abstentionReasons.push("home starter not confirmed");
      if (!awayStarterRow || !awayStarterRow.confirmed) abstentionReasons.push("away starter not confirmed");
    } else {
      if (!homeStarterRow) abstentionReasons.push("home starter missing");
      if (!awayStarterRow) abstentionReasons.push("away starter missing");
    }

    if (abstentionReasons.length > 0) {
      // Don't spam abstention rows; only insert one per (game,class) absence.
      const { data: existingAbst } = await supabaseAdmin
        .from("petri_forecast_runs")
        .select("id")
        .eq("game_id", g.id)
        .eq("projection_class", intendedClass)
        .eq("status", "abstained")
        .limit(1);
      if (!existingAbst || existingAbst.length === 0) {
        const hash = await inputHash({ game: g.mlb_game_id, class: intendedClass, reasons: abstentionReasons });
        await supabaseAdmin.from("petri_forecast_runs").insert({
          game_id: g.id,
          mlb_game_id: g.mlb_game_id,
          game_date: g.date,
          model_version: MODEL_VERSION,
          projection_class: intendedClass,
          status: "abstained",
          seed: 0,
          iterations: 0,
          input_hash: hash,
          input_source_map: sources,
          data_completeness: { score: 0 },
          fallbacks,
          abstention_reasons: abstentionReasons,
        });
      }
      summary.abstained.push({
        mlb_game_id: g.mlb_game_id,
        matchup,
        reason: abstentionReasons.join("; "),
      });
      continue;
    }

    summary.eligibleGames++;

    const homeStarterPlayer = playerByUuid.get(homeStarterRow!.player_id);
    const awayStarterPlayer = playerByUuid.get(awayStarterRow!.player_id);

    if (!homeStarterPlayer || !awayStarterPlayer) {
      const reasons = ["missing player metadata for starter"];
      const hash = await inputHash({ game: g.mlb_game_id, class: intendedClass, reasons });
      await supabaseAdmin.from("petri_forecast_runs").insert({
        game_id: g.id, mlb_game_id: g.mlb_game_id, game_date: g.date,
        model_version: MODEL_VERSION, projection_class: intendedClass, status: "abstained",
        seed: 0, iterations: 0, input_hash: hash, input_source_map: sources,
        data_completeness: { score: 0 }, fallbacks, abstention_reasons: reasons,
      });
      summary.abstained.push({ mlb_game_id: g.mlb_game_id, matchup, reason: reasons.join("; ") });
      continue;
    }

    const park = petriParkFactor(g.ballpark, sources);

    // ----- IDEMPOTENCY: compute hash BEFORE expensive sim work -----
    const homeLineupMlb = homeLineup
      .map((l) => [l.batting_order, playerByUuid.get(l.player_id)?.mlb_id ?? 0])
      .sort((a, b) => (a[0] as number) - (b[0] as number));
    const awayLineupMlb = awayLineup
      .map((l) => [l.batting_order, playerByUuid.get(l.player_id)?.mlb_id ?? 0])
      .sort((a, b) => (a[0] as number) - (b[0] as number));

    const hashInput = {
      game: g.mlb_game_id,
      class: intendedClass,
      model: MODEL_VERSION,
      profileVersion: PETRI_SKILL_PROFILE_VERSION,
      iters: ITERATIONS,
      home: { starter: homeStarterPlayer.mlb_id, lineup: homeLineupMlb },
      away: { starter: awayStarterPlayer.mlb_id, lineup: awayLineupMlb },
      park,
    };
    const hash = await inputHash(hashInput);

    const { data: existingActive } = await supabaseAdmin
      .from("petri_forecast_runs")
      .select("id, input_hash, status")
      .eq("game_id", g.id)
      .eq("model_version", MODEL_VERSION)
      .eq("projection_class", intendedClass)
      .in("status", ["preview", "locked"]);

    const sameHash = (existingActive ?? []).find((r: any) => r.input_hash === hash);
    if (sameHash) {
      summary.noChange.push({
        mlb_game_id: g.mlb_game_id,
        matchup,
        reason: `idempotent: ${intendedClass} run ${sameHash.id.slice(0, 8)} already active for this input hash`,
      });
      continue;
    }
    const locked = (existingActive ?? []).find((r: any) => r.status === "locked");
    if (locked) {
      summary.skipped.push({
        mlb_game_id: g.mlb_game_id,
        matchup,
        reason: `${intendedClass} forecast already locked at first pitch`,
      });
      continue;
    }
    const stalePreviews = (existingActive ?? []).filter((r: any) => r.status === "preview");
    if (stalePreviews.length > 0) {
      await supabaseAdmin
        .from("petri_forecast_runs")
        .update({ status: "superseded" })
        .in("id", stalePreviews.map((r: any) => r.id));
      summary.superseded += stalePreviews.length;
    }

    // ----- Build sim inputs -----
    function mapSlot(rows: typeof homeLineup, teamMlbId: number) {
      return rows.map((r) => {
        const p = playerByUuid.get(r.player_id);
        return {
          slot: r.batting_order,
          mlbId: p?.mlb_id ?? 0,
          name: p?.name ?? `Player ${r.player_id.slice(0, 6)}`,
          teamMlbId,
          playerUuid: r.player_id,
        };
      });
    }
    const homeTeamMlbId = homeTeam?.mlb_team_id ?? 0;
    const awayTeamMlbId = awayTeam?.mlb_team_id ?? 0;

    if (sources["park"] === "fallback:neutral_park") {
      fallbacks.push({
        path: "park",
        source: "neutral 100/100",
        reason: "ballpark unknown or unmapped",
        confidence_impact: "small",
      });
    }

    const homeTeamSim = buildPetriTeam(
      {
        side: "home",
        abbrev: homeTeam?.abbreviation ?? "HOME",
        lineupSlots: mapSlot(homeLineup, homeTeamMlbId),
        starter: {
          mlbId: homeStarterPlayer.mlb_id,
          name: homeStarterPlayer.name,
          teamMlbId: homeTeamMlbId,
          playerUuid: homeStarterRow!.player_id,
          confirmed: !!homeStarterRow!.confirmed,
        },
        dnaByPlayerUuid: dnaByUuid,
      },
      sources,
    );
    const awayTeamSim = buildPetriTeam(
      {
        side: "away",
        abbrev: awayTeam?.abbreviation ?? "AWAY",
        lineupSlots: mapSlot(awayLineup, awayTeamMlbId),
        starter: {
          mlbId: awayStarterPlayer.mlb_id,
          name: awayStarterPlayer.name,
          teamMlbId: awayTeamMlbId,
          playerUuid: awayStarterRow!.player_id,
          confirmed: !!awayStarterRow!.confirmed,
        },
        dnaByPlayerUuid: dnaByUuid,
      },
      sources,
    );

    for (const [path, src] of Object.entries(sources)) {
      if (src === "fallback:league_baseline" && path.endsWith(".rates")) {
        fallbacks.push({
          path,
          source: "league baseline rates",
          reason: "player_dna row missing",
          confidence_impact: "moderate",
        });
      }
    }

    // ---- Skill profile feature layer ----
    const homePlayerRows = homeLineup.map((l) => ({
      lineup: l,
      player: playerByUuid.get(l.player_id) as any,
    }));
    const awayPlayerRows = awayLineup.map((l) => ({
      lineup: l,
      player: playerByUuid.get(l.player_id) as any,
    }));

    function summarizeOpponent(rows: typeof homePlayerRows) {
      const dnas = rows
        .map((r) => dnaByUuid.get(r.lineup.player_id))
        .filter(Boolean) as DnaRow[];
      const avg = (sel: (d: DnaRow) => number) =>
        dnas.length ? dnas.reduce((s, d) => s + sel(d), 0) / dnas.length / 100 : null;
      const bats = rows.map((r) => (r.player?.bats ?? "?").toUpperCase());
      const r = bats.filter((b) => b === "R").length;
      const l = bats.filter((b) => b === "L").length;
      const known = r + l;
      return {
        avg_contact: avg((d) => d.contact),
        avg_power: avg((d) => d.power),
        avg_discipline: avg((d) => d.discipline),
        rhb_share: known ? r / known : null,
        lhb_share: known ? l / known : null,
      };
    }
    const awayOpp = summarizeOpponent(homePlayerRows);
    const homeOpp = summarizeOpponent(awayPlayerRows);

    const awayStarterProfile: PitcherSkillProfile = buildPitcherSkillProfile({
      side: "away",
      mlbId: awayStarterPlayer.mlb_id,
      name: awayStarterPlayer.name,
      teamMlbId: awayTeamMlbId,
      player: { throws: (awayStarterPlayer as any).throws ?? null },
      dna: dnaByUuid.get(awayStarterRow!.player_id),
      expectedOuts: awayTeamSim.starter.expectedOuts,
      park, ballpark: g.ballpark,
      opponentDnaSummary: awayOpp,
    });
    const homeStarterProfile: PitcherSkillProfile = buildPitcherSkillProfile({
      side: "home",
      mlbId: homeStarterPlayer.mlb_id,
      name: homeStarterPlayer.name,
      teamMlbId: homeTeamMlbId,
      player: { throws: (homeStarterPlayer as any).throws ?? null },
      dna: dnaByUuid.get(homeStarterRow!.player_id),
      expectedOuts: homeTeamSim.starter.expectedOuts,
      park, ballpark: g.ballpark,
      opponentDnaSummary: homeOpp,
    });

    function buildHitterProfiles(side: "home" | "away", rows: typeof homePlayerRows, teamMlbId: number): HitterSkillProfile[] {
      const oppHand = side === "home" ? awayStarterProfile.handedness : homeStarterProfile.handedness;
      return rows.map((r) => buildHitterSkillProfile({
        side,
        mlbId: r.player?.mlb_id ?? 0,
        name: r.player?.name ?? `Player ${r.lineup.player_id.slice(0, 6)}`,
        teamMlbId,
        lineupSlot: r.lineup.batting_order,
        player: { bats: r.player?.bats ?? null },
        opposingHand: oppHand,
        dna: dnaByUuid.get(r.lineup.player_id),
        park, ballpark: g.ballpark,
      }));
    }
    const homeHitterProfiles = buildHitterProfiles("home", homePlayerRows, homeTeamMlbId);
    const awayHitterProfiles = buildHitterProfiles("away", awayPlayerRows, awayTeamMlbId);

    function rateMatrix(hitters: HitterSkillProfile[], pitcher: PitcherSkillProfile) {
      return hitters.map((h) => {
        const out = profileToOutcomeRates({ hitter: h, pitcher, park });
        return toEnginePARates(out.rates);
      });
    }
    const homeVsStarter = rateMatrix(homeHitterProfiles, awayStarterProfile);
    const homeVsBullpen = rateMatrix(homeHitterProfiles, awayStarterProfile);
    const awayVsStarter = rateMatrix(awayHitterProfiles, homeStarterProfile);
    const awayVsBullpen = rateMatrix(awayHitterProfiles, homeStarterProfile);

    const seed = seedFromHash(hash);
    let sim: PetriSimResult;
    try {
      sim = simulate({
        home: homeTeamSim,
        away: awayTeamSim,
        park,
        iterations: ITERATIONS,
        seed,
        prebuiltRates: { homeVsStarter, homeVsBullpen, awayVsStarter, awayVsBullpen },
      });
    } catch (e: any) {
      const reason = `simulation error: ${e?.message ?? String(e)}`;
      await supabaseAdmin.from("petri_forecast_runs").insert({
        game_id: g.id, mlb_game_id: g.mlb_game_id, game_date: g.date,
        model_version: MODEL_VERSION, projection_class: intendedClass, status: "skipped",
        seed, iterations: ITERATIONS, input_hash: hash, input_source_map: sources,
        data_completeness: { score: 0 }, fallbacks, abstention_reasons: [reason],
      });
      summary.skipped.push({ mlb_game_id: g.mlb_game_id, matchup, reason });
      continue;
    }

    const completeness = computeCompleteness(sources);

    const { data: runRow, error: runErr } = await supabaseAdmin
      .from("petri_forecast_runs")
      .insert({
        game_id: g.id,
        mlb_game_id: g.mlb_game_id,
        game_date: g.date,
        model_version: MODEL_VERSION,
        projection_class: intendedClass,
        status: "preview",
        seed,
        iterations: ITERATIONS,
        input_hash: hash,
        input_source_map: sources,
        data_completeness: completeness,
        fallbacks,
        abstention_reasons: null,
      })
      .select("id")
      .single();
    if (runErr || !runRow) {
      // 23505 unique violation = another worker raced us (idempotency
      // index guarantees correctness). Treat as no-op.
      if ((runErr as any)?.code === "23505") {
        summary.noChange.push({
          mlb_game_id: g.mlb_game_id,
          matchup,
          reason: "raced: identical run inserted concurrently",
        });
        continue;
      }
      summary.skipped.push({
        mlb_game_id: g.mlb_game_id,
        matchup,
        reason: `run insert failed: ${runErr?.message ?? "unknown"}`,
      });
      continue;
    }
    const runId = runRow.id;

    // Persist per-player skill profiles for this run.
    const profileRows: any[] = [];
    function pushHitterProfiles(side: "home" | "away", profiles: HitterSkillProfile[]) {
      const teamUuid = side === "home" ? g.home_team_id : g.away_team_id;
      for (const p of profiles) {
        const opp = side === "home" ? awayStarterProfile : homeStarterProfile;
        const out = profileToOutcomeRates({ hitter: p, pitcher: opp, park });
        profileRows.push({
          run_id: runId,
          game_id: g.id,
          mlb_player_id: p.mlbId,
          team_id: teamUuid,
          role: "hitter",
          lineup_slot: p.lineupSlot,
          is_confirmed_starter: null,
          side,
          handedness: p.handedness,
          opposing_hand: opp.handedness,
          profile_version: p.profileVersion,
          features: p.features,
          fallbacks: p.fallbacks,
          adjustments: out.adjustments,
          base_rates: p.baseRates,
          pa_outcome_rates: out.rates,
          data_completeness: p.dataCompleteness,
        });
      }
    }
    function pushPitcherProfile(side: "home" | "away", p: PitcherSkillProfile) {
      profileRows.push({
        run_id: runId,
        game_id: g.id,
        mlb_player_id: p.mlbId,
        team_id: side === "home" ? g.home_team_id : g.away_team_id,
        role: "pitcher",
        lineup_slot: null,
        is_confirmed_starter: true,
        side,
        handedness: p.handedness,
        opposing_hand: null,
        profile_version: p.profileVersion,
        features: p.features,
        fallbacks: p.fallbacks,
        adjustments: [],
        base_rates: p.baseRates,
        pa_outcome_rates: p.paStandalone,
        data_completeness: p.dataCompleteness,
      });
    }
    pushHitterProfiles("home", homeHitterProfiles);
    pushHitterProfiles("away", awayHitterProfiles);
    pushPitcherProfile("home", homeStarterProfile);
    pushPitcherProfile("away", awayStarterProfile);

    const profileMlbIds = profileRows.map((r) => r.mlb_player_id).filter((id) => id && id > 0);
    const { data: profPidRows } = profileMlbIds.length
      ? await supabaseAdmin.from("players").select("id, mlb_id").in("mlb_id", profileMlbIds)
      : { data: [] as any[] };
    const profUuidByMlb = new Map((profPidRows ?? []).map((p: any) => [p.mlb_id, p.id]));
    for (const r of profileRows) r.player_id = profUuidByMlb.get(r.mlb_player_id) ?? null;

    const { error: profErr } = await supabaseAdmin
      .from("petri_skill_profiles")
      .insert(profileRows);
    if (profErr) {
      await supabaseAdmin.from("petri_forecast_runs").update({
        abstention_reasons: [`skill profile insert warning: ${profErr.message}`],
      }).eq("id", runId);
    }

    const snapshotRows: any[] = [];

    function pushHitter(side: "home" | "away", team: typeof homeTeamSim, dists: PetriSimResult["homeBatters"]) {
      team.lineup.forEach((b, i) => {
        const d = dists[i];
        const h = summarize(d.H);
        const hr = summarize(d.HR);
        const tb = summarize(d.TB);
        const k = summarize(d.K);
        const pa = summarize(d.PA);
        snapshotRows.push({
          run_id: runId,
          game_id: g.id,
          mlb_player_id: b.mlbId,
          team_id: side === "home" ? g.home_team_id : g.away_team_id,
          role: "hitter",
          lineup_slot: b.lineupSlot,
          is_confirmed_starter: null,
          h_mean: h.mean, h_p10: h.p10, h_p50: h.p50, h_p90: h.p90, hit_1plus: h.probAtLeast1,
          tb_mean: tb.mean, tb_p10: tb.p10, tb_p50: tb.p50, tb_p90: tb.p90, tb_2plus: tb.probAtLeast2,
          hr_mean: hr.mean, hr_p10: hr.p10, hr_p50: hr.p50, hr_p90: hr.p90, hr_1plus: hr.probAtLeast1,
          hitter_k_mean: k.mean, hitter_k_p10: k.p10, hitter_k_p50: k.p50, hitter_k_p90: k.p90,
          pa_mean: pa.mean,
          source_map: { rates: sources[`${side}.lineup.${b.lineupSlot}.rates`] ?? "unknown", player: sources[`${side}.lineup.${b.lineupSlot}.player`] ?? "unknown" },
          data_completeness: completeness.score,
        });
      });
    }
    pushHitter("home", homeTeamSim, sim.homeBatters);
    pushHitter("away", awayTeamSim, sim.awayBatters);

    function pushPitcher(side: "home" | "away", team: typeof homeTeamSim, dists: PetriSimResult["homePitcher"]) {
      const k = summarize(dists.K);
      const outs = summarize(dists.outs);
      const bf = summarize(dists.BF);
      snapshotRows.push({
        run_id: runId,
        game_id: g.id,
        mlb_player_id: team.starter.mlbId,
        team_id: side === "home" ? g.home_team_id : g.away_team_id,
        role: "pitcher",
        lineup_slot: null,
        is_confirmed_starter: true,
        pk_mean: k.mean, pk_p10: k.p10, pk_p90: k.p90,
        outs_mean: outs.mean, outs_p10: outs.p10, outs_p90: outs.p90,
        bf_mean: bf.mean,
        source_map: { rates: sources[`${side}.starter.rates`] ?? "unknown", player: sources[`${side}.starter.player`] ?? "unknown" },
        data_completeness: completeness.score,
      });
    }
    pushPitcher("home", homeTeamSim, sim.homePitcher);
    pushPitcher("away", awayTeamSim, sim.awayPitcher);

    const mlbIds = snapshotRows.map((r) => r.mlb_player_id).filter((id) => id && id > 0);
    const { data: pidRows } = mlbIds.length
      ? await supabaseAdmin.from("players").select("id, mlb_id").in("mlb_id", mlbIds)
      : { data: [] as any[] };
    const uuidByMlb = new Map((pidRows ?? []).map((p: any) => [p.mlb_id, p.id]));
    for (const r of snapshotRows) r.player_id = uuidByMlb.get(r.mlb_player_id) ?? null;

    const { error: snapErr } = await supabaseAdmin
      .from("petri_player_market_snapshots")
      .insert(snapshotRows);
    if (snapErr) {
      summary.skipped.push({
        mlb_game_id: g.mlb_game_id,
        matchup,
        reason: `snapshot insert failed: ${snapErr.message}`,
      });
      continue;
    }
    summary.generated++;
    summary.hitterSnapshots += snapshotRows.filter((r) => r.role === "hitter").length;
    summary.pitcherSnapshots += snapshotRows.filter((r) => r.role === "pitcher").length;
  }

  return summary;
}

/**
 * Auto-runner — invoked by the orchestrator after each Alpha refresh cycle.
 * Runs PREVIEW first, then OFFICIAL, then locks any preview-status runs whose
 * game has reached first pitch. Fully idempotent; safe to call every cycle.
 */
export async function runPetriAutoForDate(
  supabaseAdmin: SupabaseClient,
  date: string,
  opts?: { gameIds?: string[] },
): Promise<PetriRunSummary> {
  const startedAt = Date.now();
  const preview = await runPetriPipeline(supabaseAdmin, {
    date,
    intendedClass: "preview",
    gameIds: opts?.gameIds,
  });
  const official = await runPetriPipeline(supabaseAdmin, {
    date,
    intendedClass: "official",
    gameIds: opts?.gameIds,
  });
  const locked = await lockPetriForecastsAtFirstPitch(supabaseAdmin, date);

  return {
    date,
    eligibleGames: Math.max(preview.eligibleGames, official.eligibleGames),
    generated: preview.generated + official.generated,
    abstained: [...preview.abstained, ...official.abstained],
    skipped: [...preview.skipped, ...official.skipped],
    locked,
    hitterSnapshots: preview.hitterSnapshots + official.hitterSnapshots,
    pitcherSnapshots: preview.pitcherSnapshots + official.pitcherSnapshots,
    durationMs: Date.now() - startedAt,
    preview,
    official,
  };
}

// ---------- Server functions (admin manual retry + read APIs) ----------

export const runPetriShadowForUnstarted = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { date?: string } | undefined) => d ?? {})
  .handler(async ({ data, context }): Promise<PetriRunSummary> => {
    await ensureAdmin(context as any);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.date ?? todayInAppTz();
    return runPetriAutoForDate(supabaseAdmin, date);
  });

export type PetriRunListRow = {
  id: string;
  game_id: string;
  mlb_game_id: number;
  matchup: string;
  status: string;
  projection_class: string;
  seed: number;
  iterations: number;
  input_hash: string;
  data_completeness: number;
  fallback_count: number;
  abstention_reasons: string[] | null;
  created_at: string;
  locked_at: string | null;
};

export const getPetriRunsForDate = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { date?: string } | undefined) => d ?? {})
  .handler(async ({ data, context }): Promise<{ date: string; runs: PetriRunListRow[] }> => {
    await ensureAdmin(context as any);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.date ?? todayInAppTz();
    const { data: runs } = await supabaseAdmin
      .from("petri_forecast_runs")
      .select(
        "id, game_id, mlb_game_id, status, projection_class, seed, iterations, input_hash, data_completeness, fallbacks, abstention_reasons, created_at, locked_at",
      )
      .eq("game_date", date)
      .order("created_at", { ascending: false });

    const gameIds = Array.from(new Set((runs ?? []).map((r: any) => r.game_id)));
    const { data: games } = gameIds.length
      ? await supabaseAdmin
          .from("games")
          .select("id, home_team_id, away_team_id")
          .in("id", gameIds)
      : { data: [] as any[] };
    const teamIds = Array.from(
      new Set((games ?? []).flatMap((g: any) => [g.home_team_id, g.away_team_id]).filter(Boolean)),
    );
    const { data: teams } = teamIds.length
      ? await supabaseAdmin.from("teams").select("id, abbreviation").in("id", teamIds)
      : { data: [] as any[] };
    const teamById = new Map((teams ?? []).map((t: any) => [t.id, t.abbreviation as string]));
    const gById = new Map((games ?? []).map((g: any) => [g.id, g]));

    const result: PetriRunListRow[] = (runs ?? []).map((r: any) => {
      const g = gById.get(r.game_id);
      const homeAb = g ? teamById.get(g.home_team_id) ?? "?" : "?";
      const awayAb = g ? teamById.get(g.away_team_id) ?? "?" : "?";
      return {
        id: r.id,
        game_id: r.game_id,
        mlb_game_id: r.mlb_game_id,
        matchup: `${awayAb}@${homeAb}`,
        status: r.status,
        projection_class: r.projection_class ?? "preview",
        seed: Number(r.seed),
        iterations: r.iterations,
        input_hash: r.input_hash,
        data_completeness: typeof r.data_completeness === "object" ? (r.data_completeness?.score ?? 0) : Number(r.data_completeness ?? 0),
        fallback_count: Array.isArray(r.fallbacks) ? r.fallbacks.length : 0,
        abstention_reasons: r.abstention_reasons ?? null,
        created_at: r.created_at,
        locked_at: r.locked_at,
      };
    });
    return { date, runs: result };
  });

export type PetriRunDetail = {
  run: {
    id: string;
    mlb_game_id: number;
    matchup: string;
    status: string;
    projection_class: string;
    seed: number;
    iterations: number;
    input_hash: string;
    input_source_map: Record<string, string>;
    data_completeness: { score: number; breakdown?: Record<string, number> };
    fallbacks: Array<{ path: string; source: string; reason: string; confidence_impact: string }> | null;
    abstention_reasons: string[] | null;
    created_at: string;
    locked_at: string | null;
  };
  hitters: Array<{
    mlb_player_id: number;
    player_name: string;
    lineup_slot: number;
    h_mean: number; hit_1plus: number;
    tb_mean: number; tb_2plus: number;
    hr_mean: number; hr_1plus: number;
    pa_mean: number;
    hitter_k_mean: number;
    data_completeness: number;
    source_map: Record<string, string>;
  }>;
  pitchers: Array<{
    mlb_player_id: number;
    player_name: string;
    pk_mean: number; pk_p10: number; pk_p90: number;
    outs_mean: number; outs_p10: number; outs_p90: number;
    bf_mean: number;
    data_completeness: number;
    source_map: Record<string, string>;
  }>;
};

export const getPetriRunDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { runId: string }) => d)
  .handler(async ({ data, context }): Promise<PetriRunDetail | null> => {
    await ensureAdmin(context as any);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: run } = await supabaseAdmin
      .from("petri_forecast_runs")
      .select("*")
      .eq("id", data.runId)
      .maybeSingle();
    if (!run) return null;
    const { data: g } = await supabaseAdmin
      .from("games")
      .select("id, home_team_id, away_team_id")
      .eq("id", run.game_id)
      .maybeSingle();
    const teamIds = [g?.home_team_id, g?.away_team_id].filter(Boolean) as string[];
    const { data: teams } = teamIds.length
      ? await supabaseAdmin.from("teams").select("id, abbreviation").in("id", teamIds)
      : { data: [] as any[] };
    const teamById = new Map((teams ?? []).map((t: any) => [t.id, t.abbreviation as string]));
    const homeAb = g ? teamById.get(g.home_team_id) ?? "?" : "?";
    const awayAb = g ? teamById.get(g.away_team_id) ?? "?" : "?";

    const { data: snaps } = await supabaseAdmin
      .from("petri_player_market_snapshots")
      .select("*")
      .eq("run_id", run.id);

    const playerIds = Array.from(new Set((snaps ?? []).map((s: any) => s.player_id).filter(Boolean)));
    const { data: players } = playerIds.length
      ? await supabaseAdmin.from("players").select("id, name, mlb_id").in("id", playerIds)
      : { data: [] as any[] };
    const nameById = new Map((players ?? []).map((p: any) => [p.id, p.name as string]));

    function nameFor(s: any): string {
      if (s.player_id && nameById.has(s.player_id)) return nameById.get(s.player_id)!;
      return `MLB#${s.mlb_player_id}`;
    }

    const hitters = (snaps ?? [])
      .filter((s: any) => s.role === "hitter")
      .sort((a: any, b: any) => (a.lineup_slot ?? 99) - (b.lineup_slot ?? 99))
      .map((s: any) => ({
        mlb_player_id: s.mlb_player_id,
        player_name: nameFor(s),
        lineup_slot: s.lineup_slot,
        h_mean: Number(s.h_mean ?? 0),
        hit_1plus: Number(s.hit_1plus ?? 0),
        tb_mean: Number(s.tb_mean ?? 0),
        tb_2plus: Number(s.tb_2plus ?? 0),
        hr_mean: Number(s.hr_mean ?? 0),
        hr_1plus: Number(s.hr_1plus ?? 0),
        pa_mean: Number(s.pa_mean ?? 0),
        hitter_k_mean: Number(s.hitter_k_mean ?? 0),
        data_completeness: Number(s.data_completeness ?? 0),
        source_map: s.source_map ?? {},
      }));

    const pitchers = (snaps ?? [])
      .filter((s: any) => s.role === "pitcher")
      .map((s: any) => ({
        mlb_player_id: s.mlb_player_id,
        player_name: nameFor(s),
        pk_mean: Number(s.pk_mean ?? 0),
        pk_p10: Number(s.pk_p10 ?? 0),
        pk_p90: Number(s.pk_p90 ?? 0),
        outs_mean: Number(s.outs_mean ?? 0),
        outs_p10: Number(s.outs_p10 ?? 0),
        outs_p90: Number(s.outs_p90 ?? 0),
        bf_mean: Number(s.bf_mean ?? 0),
        data_completeness: Number(s.data_completeness ?? 0),
        source_map: s.source_map ?? {},
      }));

    return {
      run: {
        id: run.id,
        mlb_game_id: run.mlb_game_id,
        matchup: `${awayAb}@${homeAb}`,
        status: run.status,
        projection_class: (run as any).projection_class ?? "preview",
        seed: Number(run.seed),
        iterations: run.iterations,
        input_hash: run.input_hash,
        input_source_map: (run.input_source_map as Record<string, string> | null) ?? {},
        data_completeness: (run.data_completeness as { score: number; breakdown?: Record<string, number> } | null) ?? { score: 0 },
        fallbacks: (run.fallbacks as PetriRunDetail["run"]["fallbacks"]) ?? null,
        abstention_reasons: (run.abstention_reasons as string[] | null) ?? null,
        created_at: run.created_at,
        locked_at: run.locked_at,
      },
      hitters,
      pitchers,
    };
  });
