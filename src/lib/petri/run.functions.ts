/**
 * Petri v0.2 Shadow Lab — server functions.
 *
 * Admin-only. Fully isolated from Alpha 0.3. Reads stored app data, runs a
 * seeded Monte Carlo, persists results into petri_* tables. Never writes to
 * forecast_runs / forecast_player_projections / projections.
 */
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

const ITERATIONS = 10000;

async function ensureAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin only");
}

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
};

export const runPetriShadowForUnstarted = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { date?: string } | undefined) => d ?? {})
  .handler(async ({ data, context }): Promise<PetriRunSummary> => {
    await ensureAdmin(context as any);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.date ?? todayInAppTz();
    const startedAt = Date.now();

    const summary: PetriRunSummary = {
      date,
      eligibleGames: 0,
      generated: 0,
      abstained: [],
      skipped: [],
      locked: 0,
      hitterSnapshots: 0,
      pitcherSnapshots: 0,
      durationMs: 0,
    };

    // Load games for the date
    const { data: games, error: gErr } = await supabaseAdmin
      .from("games")
      .select(
        "id, mlb_game_id, date, game_status, first_pitch_at, ballpark, home_team_id, away_team_id",
      )
      .eq("date", date);
    if (gErr) throw new Error(gErr.message);
    if (!games || games.length === 0) {
      summary.durationMs = Date.now() - startedAt;
      return summary;
    }

    // Pull related data in bulk
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

    // Player meta for all involved player ids
    const playerUuids = Array.from(
      new Set([
        ...(lineups ?? []).map((l) => l.player_id),
        ...(starters ?? []).map((s) => s.player_id),
      ]),
    );

    const { data: players } = playerUuids.length
      ? await supabaseAdmin
          .from("players")
          .select("id, mlb_id, name, team_id")
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

      // Skip games that have already started — Petri NEVER runs against live games.
      if (gameHasStartedOrPastStart(g.game_status, g.first_pitch_at)) {
        summary.skipped.push({
          mlb_game_id: g.mlb_game_id,
          matchup,
          reason: `game already started (${g.game_status ?? "unknown"})`,
        });
        continue;
      }

      summary.eligibleGames++;

      const sources: SourceMap = {};
      const fallbacks: Array<{ path: string; source: string; reason: string; confidence_impact: string }> = [];
      const abstentionReasons: string[] = [];

      // Build lineups for home/away
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

      if (homeLineup.length !== 9) abstentionReasons.push(`home lineup has ${homeLineup.length}/9 slots`);
      if (awayLineup.length !== 9) abstentionReasons.push(`away lineup has ${awayLineup.length}/9 slots`);
      if (!homeStarterRow || !homeStarterRow.confirmed) abstentionReasons.push("home starter not confirmed");
      if (!awayStarterRow || !awayStarterRow.confirmed) abstentionReasons.push("away starter not confirmed");

      if (abstentionReasons.length > 0) {
        // Persist abstention run
        const hashInput = { game: g.mlb_game_id, reasons: abstentionReasons };
        const hash = inputHash(hashInput);
        await supabaseAdmin.from("petri_forecast_runs").insert({
          game_id: g.id,
          mlb_game_id: g.mlb_game_id,
          game_date: g.date,
          status: "abstained",
          seed: 0,
          iterations: 0,
          input_hash: hash,
          input_source_map: sources,
          data_completeness: { score: 0 },
          fallbacks,
          abstention_reasons: abstentionReasons,
        });
        summary.abstained.push({
          mlb_game_id: g.mlb_game_id,
          matchup,
          reason: abstentionReasons.join("; "),
        });
        continue;
      }

      // Map lineup rows to required slot shape
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

      const homeStarterPlayer = playerByUuid.get(homeStarterRow!.player_id);
      const awayStarterPlayer = playerByUuid.get(awayStarterRow!.player_id);

      if (!homeStarterPlayer || !awayStarterPlayer) {
        abstentionReasons.push("missing player metadata for confirmed starter");
        const hash = inputHash({ game: g.mlb_game_id, reasons: abstentionReasons });
        await supabaseAdmin.from("petri_forecast_runs").insert({
          game_id: g.id, mlb_game_id: g.mlb_game_id, game_date: g.date, status: "abstained",
          seed: 0, iterations: 0, input_hash: hash, input_source_map: sources,
          data_completeness: { score: 0 }, fallbacks, abstention_reasons: abstentionReasons,
        });
        summary.abstained.push({ mlb_game_id: g.mlb_game_id, matchup, reason: abstentionReasons.join("; ") });
        continue;
      }

      const park = petriParkFactor(g.ballpark, sources);
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
            confirmed: true,
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
            confirmed: true,
          },
          dnaByPlayerUuid: dnaByUuid,
        },
        sources,
      );

      // Record DNA fallbacks explicitly
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

      const hashInput = {
        game: g.mlb_game_id,
        model: "petri-v0.2-shadow",
        iters: ITERATIONS,
        home: {
          starter: homeStarterPlayer.mlb_id,
          lineup: homeTeamSim.lineup.map((b) => [b.lineupSlot, b.mlbId]),
        },
        away: {
          starter: awayStarterPlayer.mlb_id,
          lineup: awayTeamSim.lineup.map((b) => [b.lineupSlot, b.mlbId]),
        },
        park,
      };
      const hash = inputHash(hashInput);
      const seed = seedFromHash(hash);

      let sim: PetriSimResult;
      try {
        sim = simulate({
          home: homeTeamSim,
          away: awayTeamSim,
          park,
          iterations: ITERATIONS,
          seed,
        });
      } catch (e: any) {
        const reason = `simulation error: ${e?.message ?? String(e)}`;
        await supabaseAdmin.from("petri_forecast_runs").insert({
          game_id: g.id, mlb_game_id: g.mlb_game_id, game_date: g.date, status: "skipped",
          seed, iterations: ITERATIONS, input_hash: hash, input_source_map: sources,
          data_completeness: { score: 0 }, fallbacks, abstention_reasons: [reason],
        });
        summary.skipped.push({ mlb_game_id: g.mlb_game_id, matchup, reason });
        continue;
      }

      const completeness = computeCompleteness(sources);

      // Insert run
      const { data: runRow, error: runErr } = await supabaseAdmin
        .from("petri_forecast_runs")
        .insert({
          game_id: g.id,
          mlb_game_id: g.mlb_game_id,
          game_date: g.date,
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
        summary.skipped.push({
          mlb_game_id: g.mlb_game_id,
          matchup,
          reason: `run insert failed: ${runErr?.message ?? "unknown"}`,
        });
        continue;
      }
      const runId = runRow.id;

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

      // Resolve player UUIDs and write snapshots
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

    // Lock any preview runs whose game has now started.
    const { data: openRuns } = await supabaseAdmin
      .from("petri_forecast_runs")
      .select("id, game_id")
      .eq("status", "preview")
      .eq("game_date", date);
    if (openRuns && openRuns.length) {
      const gids = openRuns.map((r) => r.game_id);
      const { data: gRows } = await supabaseAdmin
        .from("games")
        .select("id, game_status, first_pitch_at")
        .in("id", gids);
      const startedIds = (gRows ?? [])
        .filter((g: any) => gameHasStartedOrPastStart(g.game_status, g.first_pitch_at))
        .map((g: any) => g.id);
      if (startedIds.length) {
        const ids = openRuns.filter((r) => startedIds.includes(r.game_id)).map((r) => r.id);
        if (ids.length) {
          await supabaseAdmin
            .from("petri_forecast_runs")
            .update({ status: "locked", locked_at: new Date().toISOString() })
            .in("id", ids);
          summary.locked = ids.length;
        }
      }
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
  });

export type PetriRunListRow = {
  id: string;
  game_id: string;
  mlb_game_id: number;
  matchup: string;
  status: string;
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
        "id, game_id, mlb_game_id, status, seed, iterations, input_hash, data_completeness, fallbacks, abstention_reasons, created_at, locked_at",
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
