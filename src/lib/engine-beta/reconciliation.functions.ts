/**
 * Diamond Engine Beta — Slate Reconciliation (read-only + safe regrade).
 *
 * Read-only diagnostic view of a slate. For each scheduled game, reports the
 * truthful state of every pipeline stage (schedule, lineups, baseline forecast,
 * shadow, per-game snapshot, actuals) and applies a strict pregame-validity
 * gate to label whether the game is gradable.
 *
 * "Regrade" here re-reads the existing grading logic against final actuals for
 * the single per-game snapshot supplied. It never creates a snapshot, never
 * mutates snapshot rows, never creates a retroactive lock, and never writes
 * to any public model table.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { todayInAppTz } from "@/lib/timezone";
import { findCategory, type EngineBetaCategoryKey } from "./categories";

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

// ---------- getSlateReconciliation ----------

export type ReconciliationGame = {
  gameId: string;
  gamePk: number;
  homeAbbr: string | null;
  awayAbbr: string | null;
  firstPitchAt: string | null;
  gameStatus: string | null;
  isFinal: boolean;
  lineup: {
    status: string | null;
    confidence: number | null;
    hittersSet: number;
    hittersExpected: number;
  } | null;
  baseline: {
    exists: boolean;
    status: string | null;
    projectionClass: string | null;
    generatedAt: string | null;
    lockedAt: string | null;
    lockedBeforeFirstPitch: boolean | null;
    reason: string;
  };
  shadow: {
    exists: boolean;
    createdAt: string | null;
  };
  snapshot: {
    exists: boolean;
    id: string | null;
    lockMode: string | null;
    lockReason: string | null;
    createdAt: string | null;
    createdBeforeFirstPitch: boolean | null;
    rowsCount: number;
  };
  actualsCount: number;
  gradeable: boolean;
  gradeableLabel: string;
  pipelineReason: string;
};

export type ReconciliationPayload = {
  slateDate: string;
  totalGames: number;
  gradeable: number;
  games: ReconciliationGame[];
};

export const getSlateReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string }) => data)
  .handler(async ({ data, context }): Promise<ReconciliationPayload> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;
    const date = data.date ?? todayInAppTz();

    const { data: games } = await admin
      .from("games")
      .select("id, mlb_game_id, first_pitch_at, game_status, home_team_id, away_team_id")
      .eq("date", date)
      .order("first_pitch_at", { ascending: true });
    const gameRows: any[] = games ?? [];
    if (!gameRows.length) {
      return { slateDate: date, totalGames: 0, gradeable: 0, games: [] };
    }
    const gameIds = gameRows.map((g) => String(g.id));
    const gamePks = gameRows.map((g) => Number(g.mlb_game_id));
    const teamIds = Array.from(
      new Set(gameRows.flatMap((g) => [g.home_team_id, g.away_team_id]).filter(Boolean)),
    );

    const [
      teamsRes, lineupRes, forecastRes, shadowRes, snapshotRes, snapshotRowsRes, actualsRes,
    ] = await Promise.all([
      teamIds.length
        ? admin.from("teams").select("id, abbreviation").in("id", teamIds)
        : Promise.resolve({ data: [] }),
      admin.from("game_lineup_status")
        .select("game_id, status, confidence, hitters_set, hitters_expected")
        .in("game_id", gameIds),
      admin.from("forecast_runs")
        .select("id, game_id, status, projection_class, generated_at, locked_at")
        .in("game_id", gameIds)
        .eq("slate_date", date),
      admin.from("monte_carlo_form_shadow_runs")
        .select("game_id, created_at")
        .in("game_id", gameIds),
      admin.from("engine_beta_snapshots")
        .select("id, game_id, lock_mode, lock_reason, created_at, scheduled_first_pitch")
        .eq("slate_date", date)
        .not("game_id", "is", null),
      // rows_count aggregated below via a second call once we know snapshot ids
      Promise.resolve({ data: [] }),
      admin.from("projection_results")
        .select("game_id, player_id")
        .in("game_id", gameIds),
    ]);

    const teamAbbr = new Map<string, string>(
      (teamsRes.data ?? []).map((t: any) => [String(t.id), String(t.abbreviation)]),
    );

    const lineupByGame = new Map<string, any>(
      (lineupRes.data ?? []).map((r: any) => [String(r.game_id), r]),
    );
    // Prefer the *best* forecast per game: locked > published > awaiting_lineups > superseded.
    const rank: Record<string, number> = {
      locked: 4, published: 3, awaiting_lineups: 2, superseded: 1, legacy_unverified: 0,
    };
    const bestForecast = new Map<string, any>();
    for (const f of (forecastRes.data ?? []) as any[]) {
      const key = String(f.game_id);
      const prev = bestForecast.get(key);
      if (!prev || (rank[f.status] ?? -1) > (rank[prev.status] ?? -1)) {
        bestForecast.set(key, f);
      }
    }
    const shadowByGame = new Map<string, any>(
      (shadowRes.data ?? []).map((r: any) => [String(r.game_id), r]),
    );
    const snapshotByGame = new Map<string, any>(
      (snapshotRes.data ?? []).map((r: any) => [String(r.game_id), r]),
    );

    const snapshotIds = (snapshotRes.data ?? []).map((r: any) => r.id);
    let snapshotRowsCount = new Map<string, number>();
    if (snapshotIds.length) {
      const { data: rowRows } = await admin
        .from("engine_beta_snapshot_rows")
        .select("snapshot_id")
        .in("snapshot_id", snapshotIds);
      for (const r of rowRows ?? []) {
        const k = String(r.snapshot_id);
        snapshotRowsCount.set(k, (snapshotRowsCount.get(k) ?? 0) + 1);
      }
    }
    const actualsCountByGame = new Map<string, number>();
    for (const a of actualsRes.data ?? []) {
      const k = String(a.game_id);
      actualsCountByGame.set(k, (actualsCountByGame.get(k) ?? 0) + 1);
    }

    const out: ReconciliationGame[] = [];
    let gradeable = 0;

    for (const g of gameRows) {
      const gid = String(g.id);
      const fp = g.first_pitch_at ? new Date(g.first_pitch_at) : null;
      const status = String(g.game_status ?? "");
      const isFinal = /final|game over|completed/i.test(status);

      const lineup = lineupByGame.get(gid) ?? null;
      const forecast = bestForecast.get(gid) ?? null;
      const shadow = shadowByGame.get(gid) ?? null;
      const snap = snapshotByGame.get(gid) ?? null;

      const lockedAt = forecast?.locked_at ? new Date(forecast.locked_at) : null;
      const lockedBefore = fp && lockedAt ? lockedAt.getTime() < fp.getTime() : null;
      const snapCreated = snap?.created_at ? new Date(snap.created_at) : null;
      const snapBefore = fp && snapCreated ? snapCreated.getTime() < fp.getTime() : null;

      // Pipeline reason for the baseline stage.
      let pipelineReason: string;
      if (!forecast) {
        pipelineReason = "No baseline forecast attempted";
      } else if (forecast.status === "awaiting_lineups") {
        pipelineReason = "Baseline generated · awaiting confirmed lineup at lock time";
      } else if (forecast.status === "superseded") {
        pipelineReason = "Baseline generated then superseded (never locked)";
      } else if (forecast.status === "locked") {
        pipelineReason = lockedBefore
          ? "Baseline locked pre-first-pitch"
          : "Baseline lock timestamp is at/after first pitch";
      } else if (forecast.status === "published") {
        pipelineReason = "Baseline published, never auto-locked";
      } else {
        pipelineReason = `Baseline status: ${forecast.status}`;
      }

      // Gradeable gate — all four must hold.
      const hasSnap = !!snap;
      const snapImmutable = hasSnap && !snap.lock_reason;
      const isGradeable = !!(
        hasSnap && snapImmutable && snapBefore === true &&
        (snapshotRowsCount.get(String(snap.id)) ?? 0) > 0
      );
      if (isGradeable) gradeable += 1;

      const gradeableLabel = isGradeable
        ? "Gradable"
        : "No valid pregame snapshot — not gradeable";

      out.push({
        gameId: gid,
        gamePk: Number(g.mlb_game_id),
        homeAbbr: teamAbbr.get(String(g.home_team_id)) ?? null,
        awayAbbr: teamAbbr.get(String(g.away_team_id)) ?? null,
        firstPitchAt: g.first_pitch_at ?? null,
        gameStatus: g.game_status ?? null,
        isFinal,
        lineup: lineup
          ? {
              status: lineup.status,
              confidence: lineup.confidence,
              hittersSet: lineup.hitters_set,
              hittersExpected: lineup.hitters_expected,
            }
          : null,
        baseline: {
          exists: !!forecast,
          status: forecast?.status ?? null,
          projectionClass: forecast?.projection_class ?? null,
          generatedAt: forecast?.generated_at ?? null,
          lockedAt: forecast?.locked_at ?? null,
          lockedBeforeFirstPitch: lockedBefore,
          reason: pipelineReason,
        },
        shadow: {
          exists: !!shadow,
          createdAt: shadow?.created_at ?? null,
        },
        snapshot: {
          exists: hasSnap,
          id: snap?.id ?? null,
          lockMode: snap?.lock_mode ?? null,
          lockReason: snap?.lock_reason ?? null,
          createdAt: snap?.created_at ?? null,
          createdBeforeFirstPitch: snapBefore,
          rowsCount: snap ? snapshotRowsCount.get(String(snap.id)) ?? 0 : 0,
        },
        actualsCount: actualsCountByGame.get(gid) ?? 0,
        gradeable: isGradeable,
        gradeableLabel,
        pipelineReason,
      });

    }

    return {
      slateDate: date,
      totalGames: gameRows.length,
      gradeable,
      games: out,
    };
  });

// ---------- regradeGameSnapshot (safe re-read) ----------

export type RegradeRow = {
  category: string;
  player: string;
  team: string | null;
  score: number;
  baselineMean: number | null;
  shadowMean: number | null;
  actual: number | null;
  hit: boolean | null;
};

export type RegradePayload = {
  snapshotId: string;
  gamePk: number | null;
  slateDate: string;
  createdAt: string;
  lockMode: string;
  totalRows: number;
  gradedRows: number;
  byCategory: Record<string, { total: number; graded: number; hits: number; hitRate: number | null }>;
  rows: RegradeRow[];
  regradedAt: string;
};

export const regradeGameSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { snapshotId: string }) => data)
  .handler(async ({ data, context }): Promise<RegradePayload> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;

    const { data: snap, error: sErr } = await admin
      .from("engine_beta_snapshots")
      .select("id, slate_date, created_at, lock_mode, lock_reason, game_id, game_pk, scheduled_first_pitch")
      .eq("id", data.snapshotId)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!snap) throw new Error("Snapshot not found");
    if (snap.lock_reason) throw new Error("Refusing to regrade a non-immutable snapshot");
    if (!snap.game_id) throw new Error("Refusing to regrade a date-wide snapshot from this action");

    if (snap.scheduled_first_pitch) {
      const created = new Date(snap.created_at).getTime();
      const first = new Date(snap.scheduled_first_pitch).getTime();
      if (!(created < first)) {
        throw new Error("Snapshot was not created before first pitch — refusing to regrade");
      }
    }

    const { data: gameRow } = await admin
      .from("games").select("id, game_status").eq("id", snap.game_id).maybeSingle();
    const gameFinal = typeof gameRow?.game_status === "string"
      && /final|game over|completed/i.test(gameRow.game_status);

    const { data: rows } = await admin
      .from("engine_beta_snapshot_rows")
      .select("category, player_id, player_name, team_abbr, game_id, baseline, shadow, score")
      .eq("snapshot_id", snap.id);
    const snapRows: any[] = rows ?? [];

    const playerIds = Array.from(new Set(snapRows.map((r) => r.player_id).filter(Boolean)));
    const { data: actuals } = playerIds.length
      ? await admin
          .from("projection_results")
          .select("*")
          .in("player_id", playerIds)
          .eq("game_id", snap.game_id)
      : { data: [] };
    const actualByPlayer = new Map((actuals ?? []).map((r: any) => [String(r.player_id), r]));

    const byCategory: RegradePayload["byCategory"] = {};
    const outRows: RegradeRow[] = [];

    for (const r of snapRows) {
      const cat = findCategory(r.category as EngineBetaCategoryKey);
      if (!cat) continue;
      const a: any = gameFinal ? actualByPlayer.get(String(r.player_id)) : null;
      const actualVal = a ? Number(a[cat.actualsField]) : null;
      const bucket = byCategory[r.category] ?? (byCategory[r.category] = { total: 0, graded: 0, hits: 0, hitRate: null });
      bucket.total += 1;
      let hit: boolean | null = null;
      if (actualVal != null && Number.isFinite(actualVal)) {
        const over = actualVal > cat.threshold;
        hit = cat.higherIsBetter ? over : !over;
        bucket.graded += 1;
        bucket.hits += hit ? 1 : 0;
      }
      outRows.push({
        category: r.category,
        player: r.player_name ?? "—",
        team: r.team_abbr ?? null,
        score: Number(r.score),
        baselineMean: numOr(r.baseline?.mean),
        shadowMean: numOr(r.shadow?.mean),
        actual: actualVal,
        hit,
      });
    }
    for (const b of Object.values(byCategory)) b.hitRate = b.graded > 0 ? b.hits / b.graded : null;

    const gradedRows = outRows.filter((r) => r.actual != null).length;

    return {
      snapshotId: snap.id,
      gamePk: snap.game_pk ?? null,
      slateDate: snap.slate_date,
      createdAt: snap.created_at,
      lockMode: snap.lock_mode,
      totalRows: snapRows.length,
      gradedRows,
      byCategory,
      rows: outRows.sort((a, b) => b.score - a.score),
      regradedAt: new Date().toISOString(),
    };
  });

function numOr(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
