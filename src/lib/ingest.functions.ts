/**
 * Diamond Engine — admin ingestion + engine runs.
 *
 * Every server fn here is admin-only. Callers must be signed in and
 * have the `admin` role (checked via `has_role` after `requireSupabaseAuth`).
 * Reference data flows in from the public MLB Stats API.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
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
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
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

          const lineupRows = battingOrder
            .map((mlbId, idx) => ({
              game_id: game.id,
              player_id: pByMlb.get(mlbId),
              team_id: s.teamId,
              batting_order: idx + 1,
              confirmed: true,
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

export const runDiamondEngine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string; modelVersion?: string }) => data ?? {})
  .handler(async ({ data, context }): Promise<ImportResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.date ?? todayIso();

    const { data: activeVersion } = await supabaseAdmin
      .from("model_versions").select("version").eq("active", true).maybeSingle();
    const version = resolveModelVersion(activeVersion?.version, data.modelVersion);

    // Pull lineups for the day with player + game + opposing starter
    const { data: games } = await supabaseAdmin
      .from("games")
      .select("id, mlb_game_id, home_team_id, away_team_id")
      .eq("date", date);
    if (!games?.length) return { ok: true, count: 0, details: "No games for date." };

    const gameIds = games.map((g: any) => g.id);

    const { data: lineups } = await supabaseAdmin
      .from("lineups")
      .select("game_id, player_id, team_id, batting_order")
      .in("game_id", gameIds);

    const { data: sps } = await supabaseAdmin
      .from("starting_pitchers")
      .select("game_id, team_id, player_id")
      .in("game_id", gameIds);
    // Opposing SP per (game, batting team)
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
    const { data: dnaRows } = await supabaseAdmin
      .from("player_dna").select("*").in("player_id", playerIds);
    const dnaByPlayer = new Map((dnaRows ?? []).map((d: any) => [d.player_id, d]));

    const environmentByGame = new Map<string, MonteCarloGameEnvironment>();
    let environmentFailures = 0;
    if (isAlpha03(version)) {
      const { buildMonteCarloGameEnvironment } = await import("@/lib/sim.functions");
      await Promise.all((games ?? []).map(async (game: any) => {
        try {
          const { gameEnvironment } = await buildMonteCarloGameEnvironment(game.mlb_game_id);
          environmentByGame.set(game.id, gameEnvironment);
        } catch {
          environmentFailures++;
        }
      }));
    }

    const sideForTeam = (game: any, teamId: string): TeamSide =>
      teamId === game.home_team_id ? "home" : "away";

    // TODO(alpha-0.3): pitcher "DNA" is temporary and hitter-shaped. Replace
    // this with pitcher-specific grades before trusting pitcher projections.
    const projections: any[] = [];
    for (const l of lineups ?? []) {
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
          contact: Number(dna.contact),
          power: Number(dna.power),
          speed: Number(dna.speed),
          discipline: Number(dna.discipline),
          consistency: Number(dna.consistency),
        },
        pitcherQuality,
        battingOrder: l.batting_order,
        teamSide: sideForTeam(game, l.team_id),
        role: "hitter",
        gameEnvironment: environmentByGame.get(l.game_id),
      });

      projections.push({
        player_id: l.player_id,
        game_id: l.game_id,
        model_version: version,
        projection_role: out.role,
        diamond_score: out.diamond_score,
        contact_score: out.contact_score,
        power_score: out.power_score,
        speed_score: out.speed_score,
        pitcher_grade: out.pitcher_grade,
        matchup_grade: out.matchup_grade,
        confidence: out.confidence,
        hit_probability: out.hit_probability,
        total_base_probability: out.total_base_probability,
        hr_probability: out.hr_probability,
        rbi_probability: out.rbi_probability,
        sb_probability: out.sb_probability,
        run_probability: out.run_probability,
        pitcher_win_probability: out.pitcher_win_probability,
        quality_start_probability: out.quality_start_probability,
        projected_outs: out.projected_outs,
        environment_agreement: out.environment_agreement,
        game_environment: out.game_environment_inputs as any,
        inputs: out.inputs as any,
      });
    }

    for (const sp of isAlpha03(version) ? (sps ?? []) : []) {
      const game = games.find((x: any) => x.id === sp.game_id);
      if (!game) continue;
      // TODO(alpha-0.3): pitcher "DNA" currently reuses hitter-shaped
      // contact/power/speed fields until a pitcher-specific table/model exists.
      const dna = dnaByPlayer.get(sp.player_id) ?? {
        contact: 50, power: 50, speed: 35, discipline: 50, consistency: 50,
      };
      const out = projectForModelVersion(version, {
        role: "pitcher",
        teamSide: sideForTeam(game, sp.team_id),
        gameEnvironment: environmentByGame.get(sp.game_id),
        dna: {
          contact: Number(dna.contact),
          power: Number(dna.power),
          speed: Number(dna.speed),
          discipline: Number(dna.discipline),
          consistency: Number(dna.consistency),
        },
        pitcherQuality: 100 - (Number(dna.contact) || 50),
      });

      projections.push({
        player_id: sp.player_id,
        game_id: sp.game_id,
        model_version: version,
        projection_role: out.role,
        diamond_score: out.diamond_score,
        contact_score: out.contact_score,
        power_score: out.power_score,
        speed_score: out.speed_score,
        pitcher_grade: out.pitcher_grade,
        matchup_grade: out.matchup_grade,
        confidence: out.confidence,
        hit_probability: out.hit_probability,
        total_base_probability: out.total_base_probability,
        hr_probability: out.hr_probability,
        rbi_probability: out.rbi_probability,
        sb_probability: out.sb_probability,
        run_probability: out.run_probability,
        pitcher_win_probability: out.pitcher_win_probability,
        quality_start_probability: out.quality_start_probability,
        projected_outs: out.projected_outs,
        environment_agreement: out.environment_agreement,
        game_environment: out.game_environment_inputs as any,
        inputs: out.inputs as any,
      });
    }

    if (projections.length) {
      const { error } = await supabaseAdmin.from("projections").insert(projections);
      if (error) return { ok: false, error: error.message };
    }
    return {
      ok: true,
      count: projections.length,
      details: `${projections.length} projections (v${version}) with ${environmentByGame.size}/${games.length} Monte Carlo environments${environmentFailures ? ` (${environmentFailures} failed)` : ""}.`,
    };
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
    const { data: updated, error } = await supabaseAdmin
      .from("lineups").update({ locked_at: new Date().toISOString() })
      .in("game_id", gameIds).is("locked_at", null).select("game_id");
    if (error) return { ok: false, error: error.message };
    const n = updated?.length ?? 0;
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
