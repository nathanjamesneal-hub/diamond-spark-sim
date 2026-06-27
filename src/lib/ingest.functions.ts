/**
 * Diamond Engine — admin ingestion + engine runs.
 *
 * Every server fn here is admin-only. Callers must be signed in and
 * have the `admin` role (checked via `has_role` after `requireSupabaseAuth`).
 * Reference data flows in from the public MLB Stats API.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { todayInAppTz } from "@/lib/timezone";
import {
  isAlpha03,
  projectForModelVersion,
  resolveModelVersion,
} from "@/lib/engines/registry";
import type { MonteCarloGameEnvironment, TeamSide } from "@/lib/game-environment";

const MLB = "https://statsapi.mlb.com/api/v1";

async function mlb<T>(path: string): Promise<T> {
  const res = await fetch(`${MLB}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`MLB ${res.status}: ${path}`);
  return (await res.json()) as T;
}

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

function todayIso(): string {
  // App is pinned to America/Chicago — schedule imports use the same calendar day the UI shows.
  return todayInAppTz();
}

type ImportResult = { ok: true; count: number; details?: string } | { ok: false; error: string };

// ---------- Schedule ----------

export const importSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.date ?? todayIso();
    const json = await mlb<any>(
      `/schedule?sportId=1&date=${date}&hydrate=team,linescore,venue`,
    );

    const teamUpserts = new Map<number, any>();
    const games: any[] = [];
    for (const d of json.dates ?? []) {
      for (const g of d.games ?? []) {
        for (const side of ["home", "away"] as const) {
          const t = g.teams?.[side]?.team;
          if (t?.id) {
            teamUpserts.set(t.id, {
              mlb_team_id: t.id,
              abbreviation: t.abbreviation ?? t.teamCode ?? "",
              name: t.name ?? t.teamName ?? "",
              league: t.league?.name ?? null,
              division: t.division?.name ?? null,
            });
          }
        }
        games.push({
          mlb_game_id: g.gamePk,
          date,
          ballpark: g.venue?.name ?? null,
          game_status: g.status?.detailedState ?? null,
          first_pitch_at: g.gameDate ?? null,
          _home_mlb: g.teams?.home?.team?.id,
          _away_mlb: g.teams?.away?.team?.id,
        });
      }
    }

    if (teamUpserts.size) {
      const { error } = await supabaseAdmin
        .from("teams")
        .upsert(Array.from(teamUpserts.values()), { onConflict: "mlb_team_id" });
      if (error) return { ok: false, error: error.message };
    }

    // Resolve team uuids
    const { data: teamRows } = await supabaseAdmin
      .from("teams")
      .select("id, mlb_team_id");
    const teamByMlb = new Map((teamRows ?? []).map((t: any) => [t.mlb_team_id, t.id]));

    const gameRows = games.map((g) => ({
      mlb_game_id: g.mlb_game_id,
      date: g.date,
      ballpark: g.ballpark,
      game_status: g.game_status,
      first_pitch_at: g.first_pitch_at,
      home_team_id: teamByMlb.get(g._home_mlb) ?? null,
      away_team_id: teamByMlb.get(g._away_mlb) ?? null,
    }));

    if (gameRows.length) {
      const { error } = await supabaseAdmin
        .from("games")
        .upsert(gameRows, { onConflict: "mlb_game_id" });
      if (error) return { ok: false, error: error.message };
    }

    return { ok: true, count: gameRows.length, details: `${teamUpserts.size} teams, ${gameRows.length} games for ${date}` };
  });

// ---------- Lineups ----------

export const importLineups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.date ?? todayIso();

    const { data: games } = await supabaseAdmin
      .from("games")
      .select("id, mlb_game_id, home_team_id, away_team_id")
      .eq("date", date);

    if (!games?.length) return { ok: true, count: 0, details: "No games to fetch lineups for." };

    let totalLineups = 0;
    let totalPlayers = 0;

    for (const game of games) {
      try {
        const box = await mlb<any>(`/game/${game.mlb_game_id}/boxscore`);
        const sides = [
          { side: "home", teamId: game.home_team_id, box: box.teams?.home },
          { side: "away", teamId: game.away_team_id, box: box.teams?.away },
        ];

        for (const s of sides) {
          if (!s.box || !s.teamId) continue;
          const battingOrder = (s.box.battingOrder ?? []) as number[];
          if (!battingOrder.length) continue;

          // Upsert players in this lineup
          const playerUpserts = battingOrder.map((mlbId, idx) => {
            const p = s.box.players?.[`ID${mlbId}`]?.person;
            const pos = s.box.players?.[`ID${mlbId}`]?.position?.abbreviation ?? null;
            return {
              mlb_id: mlbId,
              name: p?.fullName ?? `Player ${mlbId}`,
              position: pos,
              active: true,
              _order: idx + 1,
            };
          });

          if (playerUpserts.length) {
            const { error } = await supabaseAdmin
              .from("players")
              .upsert(
                playerUpserts.map((p) => ({
                  mlb_id: p.mlb_id,
                  name: p.name,
                  position: p.position,
                  team_id: s.teamId,
                  active: true,
                })),
                { onConflict: "mlb_id" },
              );
            if (error) throw error;
            totalPlayers += playerUpserts.length;
          }

          const { data: playerRows } = await supabaseAdmin
            .from("players")
            .select("id, mlb_id")
            .in("mlb_id", battingOrder);
          const pByMlb = new Map((playerRows ?? []).map((p: any) => [p.mlb_id, p.id]));

          const nowIso = new Date().toISOString();
          const lineupRows = battingOrder
            .map((mlbId, idx) => ({
              game_id: game.id,
              player_id: pByMlb.get(mlbId),
              team_id: s.teamId,
              batting_order: idx + 1,
              confirmed: true,
              lineup_status: "confirmed",
              lineup_source: "mlb",
              imported_at: nowIso,
              confirmed_at: nowIso,
            }))
            .filter((r) => r.player_id);


          if (lineupRows.length) {
            const { error } = await supabaseAdmin
              .from("lineups")
              .upsert(lineupRows, { onConflict: "game_id,player_id" });
            if (error) throw error;
            totalLineups += lineupRows.length;
          }

          // Seed DNA defaults for new players
          const playerIds = (playerRows ?? []).map((p: any) => p.id);
          if (playerIds.length) {
            const { data: existing } = await supabaseAdmin
              .from("player_dna")
              .select("player_id")
              .in("player_id", playerIds);
            const have = new Set((existing ?? []).map((r: any) => r.player_id));
            const need = playerIds.filter((id: string) => !have.has(id));
            if (need.length) {
              await supabaseAdmin
                .from("player_dna")
                .insert(need.map((pid: string) => ({ player_id: pid })));
            }
          }
        }
      } catch (e) {
        // Skip games without boxscores yet (pre-game window)
        continue;
      }
    }

    return {
      ok: true,
      count: totalLineups,
      details: `${totalLineups} lineup spots across ${games.length} games (${totalPlayers} player upserts).`,
    };
  });

// ---------- Starting pitchers ----------

export const importStartingPitchers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.date ?? todayIso();

    const json = await mlb<any>(
      `/schedule?sportId=1&date=${date}&hydrate=probablePitcher`,
    );

    const { data: gameRows } = await supabaseAdmin
      .from("games")
      .select("id, mlb_game_id, home_team_id, away_team_id")
      .eq("date", date);
    const gameByMlb = new Map((gameRows ?? []).map((g: any) => [g.mlb_game_id, g]));

    let count = 0;
    for (const d of json.dates ?? []) {
      for (const g of d.games ?? []) {
        const game = gameByMlb.get(g.gamePk);
        if (!game) continue;
        for (const side of ["home", "away"] as const) {
          const pp = g.teams?.[side]?.probablePitcher;
          if (!pp?.id) continue;
          await supabaseAdmin
            .from("players")
            .upsert(
              { mlb_id: pp.id, name: pp.fullName ?? `Pitcher ${pp.id}`, position: "P", active: true, team_id: side === "home" ? game.home_team_id : game.away_team_id },
              { onConflict: "mlb_id" },
            );
          const { data: pRow } = await supabaseAdmin
            .from("players").select("id").eq("mlb_id", pp.id).maybeSingle();
          if (!pRow?.id) continue;
          await supabaseAdmin.from("starting_pitchers").upsert(
            {
              game_id: game.id,
              team_id: side === "home" ? game.home_team_id : game.away_team_id,
              player_id: pRow.id,
              confirmed: true,
            },
            { onConflict: "game_id,team_id" },
          );
          count++;
        }
      }
    }
    return { ok: true, count, details: `${count} starting pitcher assignments.` };
  });

// ---------- Run engine ----------

/**
 * Core engine runner extracted so the refresh runner can call it for a
 * specific subset of games (event-driven partial re-projection).
 * Diamond Engine math, registry, calibration: unchanged.
 */
export async function runDiamondEngineForGames(
  date: string,
  gameIds?: string[],
  explicitVersion?: string,
  intendedClass: "official" | "preview" = "official",
): Promise<{ projectionsInserted: number; version: string; environmentFailures: number; gamesProcessed: number; gamesEligible: number; gamesSkippedPreviewBlocked: number; gamesSkippedNotEligible: number; forecastsPublished: number; forecastClass: "official" | "preview" }> {

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: activeVersion } = await supabaseAdmin
    .from("model_versions").select("version").eq("active", true).maybeSingle();
  const version = resolveModelVersion(activeVersion?.version, explicitVersion);

  let gamesQuery = supabaseAdmin
    .from("games")
    .select("id, mlb_game_id, home_team_id, away_team_id, game_status")
    .eq("date", date);
  if (gameIds && gameIds.length) gamesQuery = gamesQuery.in("id", gameIds);
  const { data: games } = await gamesQuery;
  if (!games?.length) return { projectionsInserted: 0, version, environmentFailures: 0, gamesProcessed: 0, gamesEligible: 0, gamesSkippedPreviewBlocked: 0, gamesSkippedNotEligible: 0, forecastsPublished: 0, forecastClass: intendedClass };

  const targetGameIds = games.map((g: any) => g.id);

  const { data: lineups } = await supabaseAdmin
    .from("lineups")
    .select("game_id, player_id, team_id, batting_order, lineup_status, lineup_source, confirmed, locked_at")
    .in("game_id", targetGameIds);

  const { data: sps } = await supabaseAdmin
    .from("starting_pitchers")
    .select("game_id, team_id, player_id, confirmed")
    .in("game_id", targetGameIds);

  // Read game_lineup_status so new projection rows inherit status/source/confidence.
  const { data: glsRows } = await supabaseAdmin
    .from("game_lineup_status")
    .select("game_id, status, confidence, primary_source")
    .in("game_id", targetGameIds);
  const glsByGame = new Map((glsRows ?? []).map((r: any) => [r.game_id, r]));

  // ---------------- FORECAST CLASS GATE ----------------
  // Determine which games this run is allowed to write projections for.
  //   intendedClass='official' → require evaluateOfficialEligibility() ok.
  //   intendedClass='preview'  → refuse to write if an active 'official'
  //                              row already exists for the same (game,
  //                              model_version) — preview must never shadow
  //                              an official forecast.
  const { evaluateOfficialEligibility } = await import("@/lib/forecast/eligibility");
  let gamesSkippedNotEligible = 0;
  let gamesSkippedPreviewBlocked = 0;
  let gamesEligible = 0;

  // If preview, check which target games already have active OFFICIAL rows.
  let activeOfficialGames = new Set<string>();
  if (intendedClass === "preview") {
    const { data: existingOfficial } = await supabaseAdmin
      .from("projections")
      .select("game_id")
      .in("game_id", targetGameIds)
      .eq("model_version", version)
      .eq("projection_status", "active")
      .eq("projection_class", "official");
    activeOfficialGames = new Set((existingOfficial ?? []).map((r: any) => r.game_id as string));
  }

  const eligibleGameIds = new Set<string>();
  for (const g of games as any[]) {
    if (intendedClass === "official") {
      const r = evaluateOfficialEligibility({
        game: g,
        lineups: (lineups ?? []).filter((l: any) => l.game_id === g.id) as any[],
        starters: (sps ?? []).filter((s: any) => s.game_id === g.id) as any[],
        gls: glsByGame.get(g.id),
      });
      if (r.eligible) {
        eligibleGameIds.add(g.id);
        gamesEligible++;
      } else {
        gamesSkippedNotEligible++;
      }
    } else {
      // preview
      if (activeOfficialGames.has(g.id)) {
        gamesSkippedPreviewBlocked++;
        continue;
      }
      eligibleGameIds.add(g.id);
      gamesEligible++;
    }
  }


  const oppSpByKey = new Map<string, string>();
  for (const sp of sps ?? []) {
    const g = games.find((x: any) => x.id === sp.game_id);
    if (!g) continue;
    const oppTeam = sp.team_id === g.home_team_id ? g.away_team_id : g.home_team_id;
    oppSpByKey.set(`${sp.game_id}:${oppTeam}`, sp.player_id);
  }

  const playerIds = Array.from(new Set([
    ...(lineups ?? []).map((l: any) => l.player_id),
    ...(sps ?? []).map((sp: any) => sp.player_id),
  ]));
  const { data: dnaRows } = playerIds.length
    ? await supabaseAdmin.from("player_dna").select("*").in("player_id", playerIds)
    : { data: [] };
  const dnaByPlayer = new Map((dnaRows ?? []).map((d: any) => [d.player_id, d]));

  // Look up MLB IDs so we can join player UUIDs to engine-distribution maps
  // (which key by MLB ID).
  const { data: playerRows } = playerIds.length
    ? await supabaseAdmin.from("players").select("id, mlb_id").in("id", playerIds)
    : { data: [] };
  const mlbIdByPlayer = new Map(
    (playerRows ?? []).map((p: any) => [p.id, (p as any).mlb_id ?? null]),
  );

  // Carry-forward existing locked snapshots — locked pregame snapshots are
  // immutable, so a rerun must reuse them rather than write fresh.
  const { data: priorSnapshotRows } = await supabaseAdmin
    .from("projections")
    .select("game_id, player_id, sim_snapshot, created_at")
    .in("game_id", targetGameIds)
    .not("sim_snapshot", "is", null)
    .order("created_at", { ascending: false });
  const priorSnapshotByKey = new Map<string, any>();
  for (const row of priorSnapshotRows ?? []) {
    const k = `${row.game_id}:${row.player_id}`;
    if (!priorSnapshotByKey.has(k)) priorSnapshotByKey.set(k, row.sim_snapshot);
  }

  // Monte Carlo environment is needed for pitcher projections regardless of
  // the active hitter model version (pitcher Diamond Score uses it). We also
  // keep the full sim.result so we can lock pregame snapshots.
  const environmentByGame = new Map<string, MonteCarloGameEnvironment>();
  const simResultByGame = new Map<string, import("./sim/engine").SimResult>();
  let environmentFailures = 0;
  const needsEnvironment = isAlpha03(version) || (sps?.length ?? 0) > 0;
  if (needsEnvironment) {
    const { buildMonteCarloGameEnvironment } = await import("@/lib/sim.functions");
    await Promise.all((games ?? []).map(async (game: any) => {
      try {
        const { gameEnvironment, result } = await buildMonteCarloGameEnvironment(game.mlb_game_id);
        environmentByGame.set(game.id, gameEnvironment);
        simResultByGame.set(game.id, result);
      } catch {
        environmentFailures++;
      }
    }));
  }

  const {
    buildHitterSnapshot,
    buildPitcherSnapshot,
    isPregameStatus,
    isLineupConfirmed,
    snapshotResultToDistributions,
  } = await import("@/lib/sim-snapshot");
  const distsByGame = new Map<
    string,
    ReturnType<typeof snapshotResultToDistributions>
  >();
  for (const [gid, result] of simResultByGame) {
    distsByGame.set(gid, snapshotResultToDistributions(result));
  }
  const SNAPSHOT_ITERATIONS = 2000;

  const sideForTeam = (game: any, teamId: string | null): TeamSide =>
    teamId === game.home_team_id ? "home" : "away";

  const projections: any[] = [];
  for (const l of lineups ?? []) {
    if (!eligibleGameIds.has(l.game_id)) continue;
    const game = games.find((x: any) => x.id === l.game_id);
    if (!game) continue;
    const dna = dnaByPlayer.get(l.player_id) ?? {
      contact: 50, power: 50, speed: 50, discipline: 50, consistency: 50,
    };

    const oppSpId = oppSpByKey.get(`${l.game_id}:${l.team_id}`);
    const oppDna = oppSpId ? dnaByPlayer.get(oppSpId) : null;
    const pitcherQuality = oppDna ? 100 - (Number(oppDna.contact) || 50) : 50;

    const out = projectForModelVersion(version, {
      dna: {
        contact: Number(dna.contact), power: Number(dna.power),
        speed: Number(dna.speed), discipline: Number(dna.discipline),
        consistency: Number(dna.consistency),
      },
      pitcherQuality,
      battingOrder: l.batting_order,
      teamSide: sideForTeam(game, l.team_id),
      role: "hitter",
      gameEnvironment: environmentByGame.get(l.game_id),
    });

    const gls = glsByGame.get(l.game_id);

    // Snapshot resolution — locked snapshots are immutable.
    const snapKey = `${l.game_id}:${l.player_id}`;
    let sim_snapshot: any = priorSnapshotByKey.get(snapKey) ?? null;
    if (!sim_snapshot) {
      const eligible =
        isPregameStatus(game.game_status) &&
        isLineupConfirmed({
          lineup_status: l.lineup_status,
          gls_status: gls?.status,
          lineup_confirmed_flag: l.confirmed === true || l.locked_at != null,
        });
      if (eligible) {
        const mlbId = mlbIdByPlayer.get(l.player_id) ?? null;
        const dist =
          mlbId != null ? distsByGame.get(l.game_id)?.hittersByMlbId.get(mlbId) : undefined;
        if (dist) {
          sim_snapshot = buildHitterSnapshot({
            dist,
            game_id: l.game_id,
            game_pk: game.mlb_game_id ?? null,
            player_id: l.player_id,
            mlb_id: mlbId,
            model_version: version,
            iterations: SNAPSHOT_ITERATIONS,
          }) as any;
        }
      }
    }

    projections.push({
      player_id: l.player_id, game_id: l.game_id, model_version: version,
      projection_role: out.role,
      diamond_score: out.diamond_score, contact_score: out.contact_score,
      power_score: out.power_score, speed_score: out.speed_score,
      pitcher_grade: out.pitcher_grade, matchup_grade: out.matchup_grade,
      confidence: out.confidence,
      hit_probability: out.hit_probability, total_base_probability: out.total_base_probability,
      hr_probability: out.hr_probability, rbi_probability: out.rbi_probability,
      sb_probability: out.sb_probability, run_probability: out.run_probability,
      pitcher_win_probability: out.pitcher_win_probability,
      quality_start_probability: out.quality_start_probability,
      projected_outs: out.projected_outs,
      environment_agreement: out.environment_agreement,
      game_environment: out.game_environment_inputs as any,
      inputs: out.inputs as any,
      lineup_status: l.lineup_status ?? gls?.status ?? "projected",
      lineup_source: l.lineup_source ?? gls?.primary_source ?? null,
      lineup_confidence: gls?.confidence ?? null,
      projection_status: "active",
      projection_class: intendedClass,
      sim_snapshot,
    });
  }


  // Pitcher projections always run (independent of active hitter version).
  // We use the Alpha 0.3 pitcher engine directly so v0.1.0 hitter math is
  // unchanged but pitchers still get a real Diamond Pitcher Score.
  const { project: projectPitcherAlpha } = await import("@/lib/engines/alpha_0_3/engine");
  for (const sp of sps ?? []) {
    if (!eligibleGameIds.has(sp.game_id)) continue;
    const game = games.find((x: any) => x.id === sp.game_id);
    if (!game) continue;
    const dna = dnaByPlayer.get(sp.player_id) ?? {
      contact: 50, power: 50, speed: 35, discipline: 50, consistency: 50,
    };

    const out = projectPitcherAlpha({
      role: "pitcher",
      teamSide: sideForTeam(game, sp.team_id),
      gameEnvironment: environmentByGame.get(sp.game_id),
      dna: {
        contact: Number(dna.contact), power: Number(dna.power),
        speed: Number(dna.speed), discipline: Number(dna.discipline),
        consistency: Number(dna.consistency),
      },
      pitcherQuality: 100 - (Number(dna.contact) || 50),
    });
    const gls = glsByGame.get(sp.game_id);

    // Snapshot resolution — immutable once locked.
    const snapKey = `${sp.game_id}:${sp.player_id}`;
    let sim_snapshot: any = priorSnapshotByKey.get(snapKey) ?? null;
    if (!sim_snapshot) {
      const eligible =
        isPregameStatus(game.game_status) &&
        isLineupConfirmed({
          gls_status: gls?.status,
          lineup_confirmed_flag: sp.confirmed === true,
        });
      if (eligible) {
        const mlbId = mlbIdByPlayer.get(sp.player_id) ?? null;
        const dist =
          mlbId != null ? distsByGame.get(sp.game_id)?.pitcherByMlbId.get(mlbId) : undefined;
        if (dist) {
          sim_snapshot = buildPitcherSnapshot({
            dist,
            game_id: sp.game_id,
            game_pk: game.mlb_game_id ?? null,
            player_id: sp.player_id,
            mlb_id: mlbId,
            model_version: version,
            iterations: SNAPSHOT_ITERATIONS,
          }) as any;
        }
      }
    }

    projections.push({
      // Tag pitcher rows with the active hitter version so the slate filter
      // (which keys off the active model_version) keeps them visible.
      player_id: sp.player_id, game_id: sp.game_id, model_version: version,
      projection_role: out.role,
      diamond_score: out.diamond_score, contact_score: out.contact_score,
      power_score: out.power_score, speed_score: out.speed_score,
      pitcher_grade: out.pitcher_grade, matchup_grade: out.matchup_grade,
      confidence: out.confidence,
      hit_probability: out.hit_probability, total_base_probability: out.total_base_probability,
      hr_probability: out.hr_probability, rbi_probability: out.rbi_probability,
      sb_probability: out.sb_probability, run_probability: out.run_probability,
      pitcher_win_probability: out.pitcher_win_probability,
      quality_start_probability: out.quality_start_probability,
      projected_outs: out.projected_outs,
      environment_agreement: out.environment_agreement,
      game_environment: out.game_environment_inputs as any,
      inputs: out.inputs as any,
      lineup_status: gls?.status ?? "projected",
      lineup_source: gls?.primary_source ?? null,
      lineup_confidence: gls?.confidence ?? null,
      projection_status: "active",
      projection_class: intendedClass,
      sim_snapshot,
    });
  }

  if (projections.length) {
    // Class-scoped supersede: a preview run must NEVER mark an active
    // 'official' row as superseded, and vice versa. The (game, version,
    // class) tuple is what the public read paths key off of.
    const eligibleGameIdList = Array.from(eligibleGameIds);
    await supabaseAdmin
      .from("projections")
      .update({ projection_status: "superseded" })
      .in("game_id", eligibleGameIdList)
      .eq("model_version", version)
      .eq("projection_status", "active")
      .eq("projection_class", intendedClass);
    const { error } = await supabaseAdmin.from("projections").insert(projections);
    if (error) throw new Error(error.message);
  }

  // Forecast Snapshot Lifecycle: dual-write a persisted, immutable forecast run
  // per ELIGIBLE game. Lifecycle still validates eligibility itself, so an
  // ineligible candidate returns 'ineligible-for-official' without writing.
  let forecastsPublished = 0;
  try {
    const { resolveAndPublishForecast } = await import("@/lib/forecast/resolve");
    const eligibleGameIdList = Array.from(eligibleGameIds);
    if (eligibleGameIdList.length) {
      const { data: gameRowsForForecast } = await supabaseAdmin
        .from("games")
        .select("id, mlb_game_id, date, game_status, first_pitch_at, home_team_id, away_team_id")
        .in("id", eligibleGameIdList);
      for (const g of gameRowsForForecast ?? []) {
        try {
          const res = await resolveAndPublishForecast({
            admin: supabaseAdmin,
            game: g as any,
            modelVersion: version,
            triggerReason: "engine_run",
            forecastClass: intendedClass,
          });
          if (res.decision === "published" || res.decision === "superseded") forecastsPublished += 1;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[forecast.lifecycle] game ${(g as any).mlb_game_id} failed:`, (e as Error).message);
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[forecast.lifecycle] resolver import failed:", (e as Error).message);
  }

  return {
    projectionsInserted: projections.length,
    version,
    environmentFailures,
    gamesProcessed: gamesEligible,
    gamesEligible,
    gamesSkippedPreviewBlocked,
    gamesSkippedNotEligible,
    forecastsPublished,
    forecastClass: intendedClass,
  };
}


export const runDiamondEngine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string; modelVersion?: string; gameIds?: string[]; intendedClass?: "official" | "preview" }) => data ?? {})
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    const date = data.date ?? todayIso();
    const intendedClass = data.intendedClass ?? "official";
    try {
      const r = await runDiamondEngineForGames(date, data.gameIds, data.modelVersion, intendedClass);
      const skippedNote =
        intendedClass === "official"
          ? ` · ${r.gamesSkippedNotEligible} skipped (lineups not confirmed)`
          : r.gamesSkippedPreviewBlocked > 0
          ? ` · ${r.gamesSkippedPreviewBlocked} skipped (active official forecast)`
          : "";
      return {
        ok: true,
        count: r.projectionsInserted,
        details: `[${intendedClass}] ${r.projectionsInserted} projections (v${r.version}) across ${r.gamesProcessed} games${r.environmentFailures ? ` (${r.environmentFailures} env failures)` : ""}${skippedNote}.`,
      };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

/**
 * Admin: publish/reissue OFFICIAL forecast for today's eligible games.
 * Wraps runDiamondEngineForGames with intendedClass='official' so that only
 * games with confirmed 9-deep lineups + both starters are written.
 */
export const publishOfficialForecast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string; gameIds?: string[]; modelVersion?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<ImportResult & {
    eligible?: number; skippedNotEligible?: number; forecastsPublished?: number;
  }> => {
    await assertAdmin(context);
    const date = data.date ?? todayIso();
    try {
      const r = await runDiamondEngineForGames(date, data.gameIds, data.modelVersion, "official");
      return {
        ok: true,
        count: r.projectionsInserted,
        eligible: r.gamesEligible,
        skippedNotEligible: r.gamesSkippedNotEligible,
        forecastsPublished: r.forecastsPublished,
        details: `[official] ${r.projectionsInserted} projections · ${r.gamesEligible} eligible · ${r.gamesSkippedNotEligible} ineligible (awaiting confirmed lineups) · ${r.forecastsPublished} forecast runs published.`,
      };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });


// ---------- One-click daily pipeline ----------
// One admin click runs: schedule → SP → confirmed lineups → aggregator
// refresh → Diamond Engine (always, for every game with a lineup OR a
// probable SP). Returns a structured debug payload so the admin UI can
// surface counts + errors per step without spelunking the logs.

export type DailyPipelineSummary = {
  ok: boolean;
  date: string;
  schedule:  { games_upserted: number; teams_upserted: number; error?: string };
  pitchers:  { sp_upserted: number; error?: string };
  lineups:   { lineup_rows: number; players_upserted: number; games_with_confirmed: number; error?: string };
  refresh:   { providers: { id: string; ok: boolean; count: number; error?: string }[]; changed_game_ids: string[]; players_changed: number; pitchers_changed: number; error?: string };
  engine:    { games_processed: number; projections_inserted: number; environment_failures: number; version: string; error?: string };
  cards:     { hitters: number; pitchers: number; games_with_projections: number; games_pending: number };
  duration_ms: number;
};

export const runDailyPipeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<DailyPipelineSummary> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runRefresh } = await import("@/lib/lineups/refresh.functions");

    const date = data.date ?? todayIso();
    const t0 = Date.now();
    const out: DailyPipelineSummary = {
      ok: true,
      date,
      schedule: { games_upserted: 0, teams_upserted: 0 },
      pitchers: { sp_upserted: 0 },
      lineups:  { lineup_rows: 0, players_upserted: 0, games_with_confirmed: 0 },
      refresh:  { providers: [], changed_game_ids: [], players_changed: 0, pitchers_changed: 0 },
      engine:   { games_processed: 0, projections_inserted: 0, environment_failures: 0, version: "" },
      cards:    { hitters: 0, pitchers: 0, games_with_projections: 0, games_pending: 0 },
      duration_ms: 0,
    };

    // Step 1 — schedule (inline; mirrors importSchedule)
    try {
      const json = await mlb<any>(`/schedule?sportId=1&date=${date}&hydrate=team,linescore,venue`);
      const teamUpserts = new Map<number, any>();
      const gameStubs: any[] = [];
      for (const d of json.dates ?? []) {
        for (const g of d.games ?? []) {
          for (const side of ["home", "away"] as const) {
            const t = g.teams?.[side]?.team;
            if (t?.id) teamUpserts.set(t.id, {
              mlb_team_id: t.id,
              abbreviation: t.abbreviation ?? t.teamCode ?? "",
              name: t.name ?? t.teamName ?? "",
              league: t.league?.name ?? null,
              division: t.division?.name ?? null,
            });
          }
          gameStubs.push({
            mlb_game_id: g.gamePk, date,
            ballpark: g.venue?.name ?? null,
            game_status: g.status?.detailedState ?? null,
            first_pitch_at: g.gameDate ?? null,
            _home_mlb: g.teams?.home?.team?.id,
            _away_mlb: g.teams?.away?.team?.id,
          });
        }
      }
      if (teamUpserts.size) {
        const { error } = await supabaseAdmin.from("teams")
          .upsert(Array.from(teamUpserts.values()), { onConflict: "mlb_team_id" });
        if (error) throw new Error(error.message);
        out.schedule.teams_upserted = teamUpserts.size;
      }
      const { data: teamRows } = await supabaseAdmin.from("teams").select("id, mlb_team_id");
      const teamByMlb = new Map((teamRows ?? []).map((t: any) => [t.mlb_team_id, t.id]));
      const gameRows = gameStubs.map((g) => ({
        mlb_game_id: g.mlb_game_id, date: g.date, ballpark: g.ballpark,
        game_status: g.game_status, first_pitch_at: g.first_pitch_at,
        home_team_id: teamByMlb.get(g._home_mlb) ?? null,
        away_team_id: teamByMlb.get(g._away_mlb) ?? null,
      }));
      if (gameRows.length) {
        const { error } = await supabaseAdmin.from("games")
          .upsert(gameRows, { onConflict: "mlb_game_id" });
        if (error) throw new Error(error.message);
      }
      out.schedule.games_upserted = gameRows.length;
    } catch (e: any) {
      out.schedule.error = e?.message ?? String(e);
    }

    // Step 2 — starting pitchers
    try {
      const json = await mlb<any>(`/schedule?sportId=1&date=${date}&hydrate=probablePitcher`);
      const { data: gameRows } = await supabaseAdmin.from("games")
        .select("id, mlb_game_id, home_team_id, away_team_id").eq("date", date);
      const gameByMlb = new Map((gameRows ?? []).map((g: any) => [g.mlb_game_id, g]));
      let count = 0;
      for (const d of json.dates ?? []) {
        for (const g of d.games ?? []) {
          const game = gameByMlb.get(g.gamePk);
          if (!game) continue;
          for (const side of ["home", "away"] as const) {
            const pp = g.teams?.[side]?.probablePitcher;
            if (!pp?.id) continue;
            await supabaseAdmin.from("players").upsert(
              { mlb_id: pp.id, name: pp.fullName ?? `Pitcher ${pp.id}`, position: "P", active: true,
                team_id: side === "home" ? game.home_team_id : game.away_team_id },
              { onConflict: "mlb_id" });
            const { data: pRow } = await supabaseAdmin.from("players")
              .select("id").eq("mlb_id", pp.id).maybeSingle();
            if (!pRow?.id) continue;
            await supabaseAdmin.from("starting_pitchers").upsert({
              game_id: game.id,
              team_id: side === "home" ? game.home_team_id : game.away_team_id,
              player_id: pRow.id, confirmed: true,
            }, { onConflict: "game_id,team_id" });
            count++;
          }
        }
      }
      out.pitchers.sp_upserted = count;
    } catch (e: any) {
      out.pitchers.error = e?.message ?? String(e);
    }

    // Step 3 — confirmed lineups (best-effort; games without batting orders are silently skipped)
    try {
      const { data: games } = await supabaseAdmin.from("games")
        .select("id, mlb_game_id, home_team_id, away_team_id").eq("date", date);
      let totalLineups = 0, totalPlayers = 0, gamesConfirmed = 0;
      for (const game of games ?? []) {
        try {
          const box = await mlb<any>(`/game/${game.mlb_game_id}/boxscore`);
          let gameHadConfirmed = false;
          for (const s of [
            { teamId: game.home_team_id, box: box.teams?.home },
            { teamId: game.away_team_id, box: box.teams?.away },
          ]) {
            if (!s.box || !s.teamId) continue;
            const battingOrder = (s.box.battingOrder ?? []) as number[];
            if (!battingOrder.length) continue;
            gameHadConfirmed = true;
            const playerUpserts = battingOrder.map((mlbId) => {
              const p = s.box.players?.[`ID${mlbId}`]?.person;
              const pos = s.box.players?.[`ID${mlbId}`]?.position?.abbreviation ?? null;
              return { mlb_id: mlbId, name: p?.fullName ?? `Player ${mlbId}`,
                position: pos, team_id: s.teamId, active: true };
            });
            const { error: pErr } = await supabaseAdmin.from("players")
              .upsert(playerUpserts, { onConflict: "mlb_id" });
            if (pErr) throw pErr;
            totalPlayers += playerUpserts.length;
            const { data: playerRows } = await supabaseAdmin.from("players")
              .select("id, mlb_id").in("mlb_id", battingOrder);
            const pByMlb = new Map((playerRows ?? []).map((p: any) => [p.mlb_id, p.id]));
            const nowIso = new Date().toISOString();
            const lineupRows = battingOrder.map((mlbId, idx) => ({
              game_id: game.id, player_id: pByMlb.get(mlbId), team_id: s.teamId,
              batting_order: idx + 1, confirmed: true,
              lineup_status: "confirmed", lineup_source: "mlb",
              imported_at: nowIso, confirmed_at: nowIso,
            })).filter((r) => r.player_id);
            if (lineupRows.length) {
              const { error } = await supabaseAdmin.from("lineups")
                .upsert(lineupRows, { onConflict: "game_id,player_id" });
              if (error) throw error;
              totalLineups += lineupRows.length;
            }
            const playerIds = (playerRows ?? []).map((p: any) => p.id);
            if (playerIds.length) {
              const { data: existing } = await supabaseAdmin.from("player_dna")
                .select("player_id").in("player_id", playerIds);
              const have = new Set((existing ?? []).map((r: any) => r.player_id));
              const need = playerIds.filter((id: string) => !have.has(id));
              if (need.length) await supabaseAdmin.from("player_dna")
                .insert(need.map((pid: string) => ({ player_id: pid })));
            }
          }
          if (gameHadConfirmed) gamesConfirmed++;
        } catch { continue; }
      }
      out.lineups.lineup_rows = totalLineups;
      out.lineups.players_upserted = totalPlayers;
      out.lineups.games_with_confirmed = gamesConfirmed;
    } catch (e: any) {
      out.lineups.error = e?.message ?? String(e);
    }

    // Step 4 — aggregator refresh (will now find games + may add projected lineups)
    try {
      const r = await runRefresh(date);
      out.refresh.providers = r.providers.map((p) => ({
        id: p.id, ok: p.ok, count: p.count, error: p.error,
      }));
      out.refresh.changed_game_ids = r.changedGameIds;
      out.refresh.players_changed = r.playersChanged;
      out.refresh.pitchers_changed = r.pitchersChanged;
    } catch (e: any) {
      out.refresh.error = e?.message ?? String(e);
    }

    // Step 5 — ALWAYS run engine for every game that has a lineup OR a probable SP.
    // This is the regression fix: refresh's incremental path skips the engine
    // when nothing changed, leaving brand-new days with no projections.
    try {
      const { data: games } = await supabaseAdmin.from("games")
        .select("id").eq("date", date);
      const allGameIds = (games ?? []).map((g: any) => g.id);
      let gamesToRun: string[] = [];
      if (allGameIds.length) {
        const [{ data: lns }, { data: sps2 }] = await Promise.all([
          supabaseAdmin.from("lineups").select("game_id").in("game_id", allGameIds),
          supabaseAdmin.from("starting_pitchers").select("game_id").in("game_id", allGameIds),
        ]);
        const have = new Set<string>([
          ...((lns ?? []).map((r: any) => r.game_id)),
          ...((sps2 ?? []).map((r: any) => r.game_id)),
        ]);
        gamesToRun = Array.from(have);
      }
      if (gamesToRun.length) {
        const r = await runDiamondEngineForGames(date, gamesToRun);
        out.engine.games_processed = r.gamesProcessed;
        out.engine.projections_inserted = r.projectionsInserted;
        out.engine.environment_failures = r.environmentFailures;
        out.engine.version = r.version;
      }
    } catch (e: any) {
      out.engine.error = e?.message ?? String(e);
    }

    // Step 6 — read back what made it to the cards
    try {
      const { data: games } = await supabaseAdmin.from("games")
        .select("id").eq("date", date);
      const allGameIds = (games ?? []).map((g: any) => g.id);
      if (allGameIds.length) {
        const { data: projs } = await supabaseAdmin.from("projections")
          .select("game_id, projection_role")
          .in("game_id", allGameIds)
          .eq("projection_status", "active");
        const gamesWith = new Set<string>();
        let h = 0, p = 0;
        for (const r of projs ?? []) {
          gamesWith.add(r.game_id);
          if (r.projection_role === "pitcher") p++; else h++;
        }
        out.cards.hitters = h;
        out.cards.pitchers = p;
        out.cards.games_with_projections = gamesWith.size;
        out.cards.games_pending = allGameIds.length - gamesWith.size;
      }
    } catch { /* non-fatal */ }

    // Step 7 — first-pitch lock pass: lock any published forecast whose game
    // is now live/final so live polling cannot overwrite it.
    try {
      const { lockForecastsForLiveGames } = await import("@/lib/forecast/lifecycle");
      const locked = await lockForecastsForLiveGames(supabaseAdmin, date);
      (out as any).forecast_locks = { locked };
    } catch (e: any) {
      (out as any).forecast_locks = { error: e?.message ?? String(e) };
    }

    out.duration_ms = Date.now() - t0;
    out.ok = !out.schedule.error && !out.engine.error;
    return out;
  });

// Per-game engine retry (used by "Needs engine run" affordance on cards).
export const runEngineForGame = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date: string; gameId: string }) => {
    if (!data?.date || !data?.gameId) throw new Error("date and gameId required");
    return data;
  })
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    try {
      const r = await runDiamondEngineForGames(data.date, [data.gameId]);
      return { ok: true, count: r.projectionsInserted,
        details: `${r.projectionsInserted} projections for game (v${r.version}).` };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

// ---------- Force run (admin manual fallback) ----------

export type ForceEngineSummary = {
  ok: boolean;
  date: string;
  version: string;
  games_found: number;
  games_processed: number;
  games_skipped: number;
  hitter_predictions: number;
  pitcher_predictions: number;
  environment_failures: number;
  per_game: Array<{
    game_id: string;
    mlb_game_id: number | null;
    matchup: string;
    lineup_players: number;
    pitchers: number;
    hitter_projections: number;
    pitcher_projections: number;
    note?: string;
  }>;
  duration_ms: number;
  error?: string;
};

export const forceRunDiamondEngine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string } | undefined) => data ?? {})
  .handler(async ({ data, context }): Promise<ForceEngineSummary> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const t0 = Date.now();
    const date = data.date ?? todayIso();

    const summary: ForceEngineSummary = {
      ok: false, date, version: "", games_found: 0, games_processed: 0,
      games_skipped: 0, hitter_predictions: 0, pitcher_predictions: 0,
      environment_failures: 0, per_game: [], duration_ms: 0,
    };

    try {
      const { data: games } = await supabaseAdmin
        .from("games")
        .select("id, mlb_game_id, home_team_id, away_team_id, home_team:teams!games_home_team_id_fkey(abbreviation), away_team:teams!games_away_team_id_fkey(abbreviation)")
        .eq("date", date);
      summary.games_found = games?.length ?? 0;
      if (!summary.games_found) {
        summary.ok = true;
        summary.duration_ms = Date.now() - t0;
        return summary;
      }

      const gameIds = (games ?? []).map((g: any) => g.id);
      const [lineupsRes, spsRes] = await Promise.all([
        supabaseAdmin.from("lineups").select("game_id, player_id").in("game_id", gameIds),
        supabaseAdmin.from("starting_pitchers").select("game_id, player_id").in("game_id", gameIds),
      ]);
      const lineupsByGame = new Map<string, number>();
      for (const l of lineupsRes.data ?? []) {
        lineupsByGame.set(l.game_id, (lineupsByGame.get(l.game_id) ?? 0) + 1);
      }
      const spsByGame = new Map<string, number>();
      for (const sp of spsRes.data ?? []) {
        spsByGame.set(sp.game_id, (spsByGame.get(sp.game_id) ?? 0) + 1);
      }

      // Run engine for every game with at least one player (lineup or SP).
      const runnable = (games ?? []).filter((g: any) =>
        (lineupsByGame.get(g.id) ?? 0) + (spsByGame.get(g.id) ?? 0) > 0
      );
      summary.games_skipped = summary.games_found - runnable.length;

      if (runnable.length) {
        const r = await runDiamondEngineForGames(date, runnable.map((g: any) => g.id));
        summary.version = r.version;
        summary.games_processed = r.gamesProcessed;
        summary.environment_failures = r.environmentFailures;

        // Per-role counts via projections query (active rows only).
        const { data: proj } = await supabaseAdmin
          .from("projections")
          .select("game_id, projection_role")
          .in("game_id", runnable.map((g: any) => g.id))
          .eq("model_version", r.version)
          .eq("projection_status", "active");
        const hitterByGame = new Map<string, number>();
        const pitcherByGame = new Map<string, number>();
        for (const p of proj ?? []) {
          if (p.projection_role === "pitcher") {
            pitcherByGame.set(p.game_id, (pitcherByGame.get(p.game_id) ?? 0) + 1);
            summary.pitcher_predictions++;
          } else {
            hitterByGame.set(p.game_id, (hitterByGame.get(p.game_id) ?? 0) + 1);
            summary.hitter_predictions++;
          }
        }

        for (const g of games ?? []) {
          const lineupCt = lineupsByGame.get(g.id) ?? 0;
          const spCt = spsByGame.get(g.id) ?? 0;
          const ran = runnable.some((x: any) => x.id === g.id);
          summary.per_game.push({
            game_id: g.id,
            mlb_game_id: g.mlb_game_id,
            matchup: `${g.away_team?.abbreviation ?? "?"} @ ${g.home_team?.abbreviation ?? "?"}`,
            lineup_players: lineupCt,
            pitchers: spCt,
            hitter_projections: hitterByGame.get(g.id) ?? 0,
            pitcher_projections: pitcherByGame.get(g.id) ?? 0,
            note: ran ? undefined : "skipped · no lineup or SP",
          });
        }
      } else {
        for (const g of games ?? []) {
          summary.per_game.push({
            game_id: g.id,
            mlb_game_id: g.mlb_game_id,
            matchup: `${g.away_team?.abbreviation ?? "?"} @ ${g.home_team?.abbreviation ?? "?"}`,
            lineup_players: 0, pitchers: 0,
            hitter_projections: 0, pitcher_projections: 0,
            note: "skipped · no lineup or SP",
          });
        }
      }

      summary.ok = true;
    } catch (e: any) {
      summary.error = e?.message ?? String(e);
    }
    summary.duration_ms = Date.now() - t0;
    return summary;
  });




// ---------- Lock ----------

export const lockProjections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.date ?? todayIso();
    const { data: games } = await supabaseAdmin.from("games").select("id").eq("date", date);
    const gameIds = (games ?? []).map((g: any) => g.id);
    if (!gameIds.length) return { ok: true, count: 0, details: "No games." };
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabaseAdmin
      .from("lineups")
      .update({ locked_at: nowIso, lineup_status: "locked" })
      .in("game_id", gameIds).is("locked_at", null).select("game_id");
    if (error) return { ok: false, error: error.message };
    const n = updated?.length ?? 0;
    await supabaseAdmin.from("games").update({ lineups_locked_at: nowIso }).in("id", gameIds).is("lineups_locked_at", null);
    await supabaseAdmin.from("game_lineup_status").update({ status: "locked" }).in("game_id", gameIds);
    return { ok: true, count: n, details: `Locked ${n} lineup spots.` };

  });

// ---------- Results ----------

export const importResults = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.date ?? todayIso();
    const { data: games } = await supabaseAdmin
      .from("games").select("id, mlb_game_id").eq("date", date);
    if (!games?.length) return { ok: true, count: 0, details: "No games." };

    let count = 0;
    for (const game of games) {
      try {
        const box = await mlb<any>(`/game/${game.mlb_game_id}/boxscore`);
        for (const side of ["home", "away"] as const) {
          const players = box.teams?.[side]?.players ?? {};
          const mlbIds = Object.values(players)
            .map((p: any) => p?.person?.id)
            .filter(Boolean) as number[];
          if (!mlbIds.length) continue;
          const { data: pRows } = await supabaseAdmin
            .from("players").select("id, mlb_id").in("mlb_id", mlbIds);
          const pByMlb = new Map((pRows ?? []).map((p: any) => [p.mlb_id, p.id]));

          const rows: any[] = [];
          for (const playerKey in players) {
            const p = players[playerKey];
            const id = p?.person?.id;
            const pid = pByMlb.get(id);
            if (!pid) continue;
            const bat = p.stats?.batting;
            if (!bat || (bat.plateAppearances ?? 0) === 0) continue;
            rows.push({
              player_id: pid,
              game_id: game.id,
              hits: bat.hits ?? 0,
              total_bases: bat.totalBases ?? 0,
              home_runs: bat.homeRuns ?? 0,
              rbis: bat.rbi ?? 0,
              runs: bat.runs ?? 0,
              stolen_bases: bat.stolenBases ?? 0,
              walks: bat.baseOnBalls ?? 0,
              strikeouts: bat.strikeOuts ?? 0,
              plate_appearances: bat.plateAppearances ?? 0,
            });
          }
          if (rows.length) {
            const { error } = await supabaseAdmin
              .from("projection_results")
              .upsert(rows, { onConflict: "player_id,game_id" });
            if (error) throw error;
            count += rows.length;
          }
        }
      } catch {
        continue;
      }
    }
    return { ok: true, count, details: `${count} player result rows.` };
  });

// ---------- Calibration ----------

export const runCalibration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { modelVersion?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: versions } = data.modelVersion
      ? await supabaseAdmin.from("model_versions").select("version").eq("version", data.modelVersion)
      : await supabaseAdmin.from("model_versions").select("version");

    let totalRows = 0;

    for (const v of versions ?? []) {
      const { data: rows } = await supabaseAdmin
        .from("projections")
        .select("player_id, game_id, confidence, hit_probability, hr_probability, total_base_probability, rbi_probability, run_probability, sb_probability, pitcher_win_probability, quality_start_probability, projected_outs")
        .eq("model_version", v.version);
      if (!rows?.length) continue;

      const keys = rows.map((r: any) => ({ p: r.player_id, g: r.game_id }));
      const playerIds = Array.from(new Set(keys.map((k) => k.p)));
      const gameIds = Array.from(new Set(keys.map((k) => k.g)));

      const { data: results } = await supabaseAdmin
        .from("projection_results")
        .select("player_id, game_id, hits, total_bases, home_runs, rbis, runs, stolen_bases")
        .in("player_id", playerIds).in("game_id", gameIds);
      const resByKey = new Map((results ?? []).map((r: any) => [`${r.player_id}:${r.game_id}`, r]));

      const stats: Array<{ key: string; probKey: string; threshold: number }> = [
        { key: "hit", probKey: "hit_probability", threshold: 1 },
        { key: "tb", probKey: "total_base_probability", threshold: 2 },
        { key: "hr", probKey: "hr_probability", threshold: 1 },
        { key: "rbi", probKey: "rbi_probability", threshold: 1 },
        { key: "run", probKey: "run_probability", threshold: 1 },
        { key: "sb", probKey: "sb_probability", threshold: 1 },
      ];
      const resultFieldByStat: Record<string, string> = {
        hit: "hits", tb: "total_bases", hr: "home_runs", rbi: "rbis", run: "runs", sb: "stolen_bases",
      };
      // TODO(alpha-0.3 calibration): pitcher_win_probability,
      // quality_start_probability, and projected_outs are not calibrated here
      // because projection_results is hitter-batting-result scoped. Calibrating
      // those requires pitcher result ingestion with starter decision, IP/outs,
      // earned runs, and quality-start eligibility.

      const bucketOf = (c: number) => (c >= 75 ? "high" : c >= 50 ? "med" : "low");
      type Agg = { sumP: number; sumO: number; sumBrier: number; n: number };
      const acc = new Map<string, Agg>();

      for (const row of rows) {
        const result = resByKey.get(`${row.player_id}:${row.game_id}`);
        if (!result) continue;
        const bucket = bucketOf(Number(row.confidence) || 50);
        for (const s of stats) {
          if ((row as any)[s.probKey] == null) continue;
          const p = Number((row as any)[s.probKey]);
          const observed = (result as any)[resultFieldByStat[s.key]] >= s.threshold ? 1 : 0;
          const key = `${v.version}|${s.key}|${bucket}`;
          const a = acc.get(key) ?? { sumP: 0, sumO: 0, sumBrier: 0, n: 0 };
          a.sumP += p; a.sumO += observed;
          a.sumBrier += (p - observed) ** 2;
          a.n += 1;
          acc.set(key, a);
        }
      }

      const upserts = Array.from(acc.entries()).map(([key, a]) => {
        const [version, stat, bucket] = key.split("|");
        return {
          model_version: version,
          stat,
          confidence_bucket: bucket,
          predicted_mean: a.n ? a.sumP / a.n : null,
          observed_mean: a.n ? a.sumO / a.n : null,
          brier_score: a.n ? a.sumBrier / a.n : null,
          log_loss: null,
          sample_size: a.n,
          computed_at: new Date().toISOString(),
        };
      });

      if (upserts.length) {
        const { error } = await supabaseAdmin
          .from("calibration_summary")
          .upsert(upserts, { onConflict: "model_version,stat,confidence_bucket" });
        if (error) return { ok: false, error: error.message };
        totalRows += upserts.length;
      }
    }
    return { ok: true, count: totalRows, details: `${totalRows} calibration buckets refreshed.` };
  });

// ---------- Model versions ----------

export const createModelVersion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { version: string; notes?: string; activate?: boolean }) => {
    if (!data?.version) throw new Error("version required");
    return data;
  })
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (data.activate) {
      await supabaseAdmin.from("model_versions").update({ active: false }).eq("active", true);
    }
    const { error } = await supabaseAdmin
      .from("model_versions")
      .insert({ version: data.version, notes: data.notes ?? null, active: !!data.activate });
    if (error) return { ok: false, error: error.message };
    return { ok: true, count: 1, details: `Created ${data.version}${data.activate ? " (active)" : ""}.` };
  });

// ---------- Recompute Player DNA ----------
// Input prep only: pulls MLB season stats and maps them to the existing
// 0-100 DNA sub-scores. Diamond Engine formulas (v0_1_0, alpha_0_3) are
// unchanged — they simply read these refreshed values.

function clamp(n: number, lo = 1, hi = 99): number {
  if (!Number.isFinite(n)) return 50;
  return Math.max(lo, Math.min(hi, n));
}

function parseIp(ip: string | number | null | undefined): number {
  // MLB returns IP as e.g. "12.2" meaning 12 + 2/3 innings
  if (ip == null) return 0;
  const s = String(ip);
  const [whole, frac = "0"] = s.split(".");
  const w = Number(whole) || 0;
  const f = Number(frac) || 0;
  return w + (f === 1 ? 1 / 3 : f === 2 ? 2 / 3 : 0);
}

function hitterDna(bat: any): { contact: number; power: number; speed: number; discipline: number; consistency: number } | null {
  const pa = Number(bat?.plateAppearances ?? 0);
  if (pa < 50) return null;
  const ab = Number(bat?.atBats ?? 0) || 1;
  const games = Number(bat?.gamesPlayed ?? 0) || 1;
  const h = Number(bat?.hits ?? 0);
  const so = Number(bat?.strikeOuts ?? 0);
  const bb = Number(bat?.baseOnBalls ?? 0);
  const hr = Number(bat?.homeRuns ?? 0);
  const sb = Number(bat?.stolenBases ?? 0);
  const tri = Number(bat?.triples ?? 0);
  const avg = Number(bat?.avg ?? h / ab);
  const slg = Number(bat?.slg ?? 0);
  const iso = Math.max(0, slg - avg);
  const kRate = so / pa;
  const bbRate = bb / pa;
  const hrRate = hr / pa;
  const sbRate = sb / games;
  const triRate = tri / games;

  const contactA = 50 + 500 * (avg - 0.245);
  const contactB = 50 + 200 * (0.77 - kRate);
  const contact = clamp((contactA + contactB) / 2);

  const powerA = 50 + 600 * (iso - 0.15);
  const powerB = 50 + 1500 * (hrRate - 0.03);
  const power = clamp((powerA + powerB) / 2);

  const speedA = 50 + 600 * (sbRate - 0.05);
  const speedB = 50 + 4000 * (triRate - 0.005);
  const speed = clamp((speedA + speedB) / 2);

  const discA = 50 + 500 * (bbRate - 0.085);
  const discB = 50 + 300 * ((bb - so) / pa - -0.1);
  const discipline = clamp((discA + discB) / 2);

  const consistency = clamp(50 + 0.3 * (games - 60));

  return { contact, power, speed, discipline, consistency };
}

function pitcherDna(pit: any): { contact: number; power: number; speed: number; discipline: number; consistency: number } | null {
  const ip = parseIp(pit?.inningsPitched);
  if (ip < 10) return null;
  const games = Number(pit?.gamesStarted ?? pit?.gamesPlayed ?? 0) || 1;
  const so = Number(pit?.strikeOuts ?? 0);
  const bb = Number(pit?.baseOnBalls ?? 0);
  const hr = Number(pit?.homeRuns ?? 0);
  const k9 = (so * 9) / ip;
  const bb9 = (bb * 9) / ip;
  const hr9 = (hr * 9) / ip;
  const ipPerStart = ip / games;

  const contact = clamp(50 + 8 * (k9 - 8.5));     // higher K/9 → higher "contact-suppression"
  const power = clamp(50 - 25 * (hr9 - 1.2));     // fewer HR/9 → higher
  const speed = 35;
  const discipline = clamp(50 - 10 * (bb9 - 3.2)); // fewer BB/9 → higher
  const consistency = clamp(50 + 8 * (ipPerStart - 5.0));

  return { contact, power, speed, discipline, consistency };
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

export const recomputePlayerDNA = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { season?: number; onlyMissing?: boolean; playerIds?: string[] }) => data ?? {})
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Resolve season: latest games.date year, else current year.
    let season = data.season;
    if (!season) {
      const { data: latest } = await supabaseAdmin
        .from("games").select("date").order("date", { ascending: false }).limit(1).maybeSingle();
      season = latest?.date ? Number(String(latest.date).slice(0, 4)) : new Date().getUTCFullYear();
    }

    // Target players
    let query = supabaseAdmin.from("players").select("id, mlb_id, position").eq("active", true);
    if (data.playerIds?.length) query = query.in("id", data.playerIds);
    const { data: players, error: pErr } = await query;
    if (pErr) return { ok: false, error: pErr.message };

    let targets = (players ?? []).filter((p: any) => p.mlb_id);

    if (data.onlyMissing) {
      const { data: dnaRows } = await supabaseAdmin
        .from("player_dna").select("player_id").not("last_recomputed_at", "is", null);
      const have = new Set((dnaRows ?? []).map((r: any) => r.player_id));
      targets = targets.filter((p: any) => !have.has(p.id));
    }

    let updated = 0;
    let skipped = 0;
    let errors = 0;
    const upserts: any[] = [];
    const now = new Date().toISOString();

    await runWithConcurrency(targets, 6, async (p: any) => {
      const isPitcher = (p.position ?? "").toUpperCase() === "P";
      const group = isPitcher ? "pitching" : "hitting";
      try {
        const json = await mlb<any>(`/people/${p.mlb_id}/stats?stats=season&group=${group}&season=${season}`);
        const stat = json?.stats?.[0]?.splits?.[0]?.stat;
        if (!stat) { skipped++; return; }
        const dna = isPitcher ? pitcherDna(stat) : hitterDna(stat);
        if (!dna) { skipped++; return; }
        upserts.push({
          player_id: p.id,
          contact: dna.contact, power: dna.power, speed: dna.speed,
          discipline: dna.discipline, consistency: dna.consistency,
          last_recomputed_at: now,
          updated_at: now,
        });
        updated++;
      } catch {
        errors++;
      }
    });

    // Upsert in chunks
    for (let i = 0; i < upserts.length; i += 200) {
      const chunk = upserts.slice(i, i + 200);
      const { error } = await supabaseAdmin.from("player_dna").upsert(chunk, { onConflict: "player_id" });
      if (error) return { ok: false, error: error.message };
    }

    return {
      ok: true,
      count: updated,
      details: `season ${season} · updated ${updated}, skipped ${skipped} (insufficient PA/IP), errors ${errors} of ${targets.length}.`,
    };
  });

