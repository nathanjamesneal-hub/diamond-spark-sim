/**
 * Diamond Engine Beta — private admin server functions.
 *
 * Reads (never writes) from:
 *   forecast_runs, forecast_player_projections,
 *   monte_carlo_form_shadow_runs, monte_carlo_form_shadow_player_outputs,
 *   player_recent_event_rates,
 *   lineups, starting_pitchers, games, players, teams,
 *   projection_results (post-game actuals).
 *
 * Writes only to:
 *   engine_beta_snapshots, engine_beta_snapshot_rows (admin-only, private).
 *
 * Never modifies public forecast, projection, or Diamond Live tables and
 * never changes public model behavior. Snapshots are immutable.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { todayInAppTz } from "@/lib/timezone";
import {
  ENGINE_BETA_CATEGORIES,
  EXCLUDED_CATEGORIES,
  findCategory,
  type EngineBetaCategoryKey,
} from "./categories";
import { ENGINE_BETA_WEIGHTS } from "./score";
import { computeBoardPayload, computeGameSnapshotRows, type BoardPayload, type BoardRow } from "./compute";
import { tryAutoLockGame, DEFAULT_LOCK_LEAD_MINUTES, DEFAULT_MISSED_GRACE_MINUTES } from "./autolock";

export type { BoardPayload, BoardRow, ReadinessState } from "./compute";

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

// ============================================================================
// Board (read-only)
// ============================================================================

export const getEngineBetaBoard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string; category?: EngineBetaCategoryKey }) => data)
  .handler(async ({ data, context }): Promise<BoardPayload> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return computeBoardPayload(supabaseAdmin, data.date ?? todayInAppTz(), data.category ?? "H");
  });

// ============================================================================
// Manual date-wide lock (kept for backward compatibility with legacy UI).
// Skips games that already have an `automatic` snapshot.
// ============================================================================

export type LockResult = { snapshotId: string; slateDate: string; version: number; rowsWritten: number; categories: EngineBetaCategoryKey[]; skippedAutoLockedGames: number };

export const lockEngineBetaBoard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string; notes?: string; newVersion?: boolean }) => data)
  .handler(async ({ data, context }): Promise<LockResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;
    const date = data.date ?? todayInAppTz();

    // Immutability guard for date-wide manual snapshots.
    const { data: existing } = await admin
      .from("engine_beta_snapshots")
      .select("id")
      .eq("slate_date", date)
      .is("game_id", null)
      .order("created_at", { ascending: true });
    const priorCount = (existing ?? []).length;
    if (priorCount > 0 && !data.newVersion) {
      throw new Error(`A locked date-wide snapshot already exists for ${date} (v${priorCount}). Prior snapshots are immutable. Pass newVersion=true to record v${priorCount + 1}.`);
    }
    const version = priorCount + 1;

    // Games with an automatic per-game snapshot are excluded — those are
    // the truthful pregame snapshots for those games and are immutable.
    const { data: autoLocked } = await admin
      .from("engine_beta_snapshots")
      .select("game_id")
      .eq("slate_date", date)
      .eq("lock_mode", "automatic")
      .not("game_id", "is", null);
    const excludedGameIds = new Set<string>((autoLocked ?? []).map((s: any) => String(s.game_id)));

    const { data: snap, error: snapErr } = await admin
      .from("engine_beta_snapshots")
      .insert({
        slate_date: date,
        created_by: context.userId,
        notes: data.notes ?? null,
        lock_mode: "manual",
        meta: {
          weights: ENGINE_BETA_WEIGHTS,
          version,
          priorSnapshotIds: (existing ?? []).map((s: any) => s.id),
          excludedAutoLockedGames: Array.from(excludedGameIds),
        },
      })
      .select("id")
      .single();
    if (snapErr) throw new Error(snapErr.message);
    const snapshotId = snap.id as string;

    let rowsWritten = 0;
    const cats: EngineBetaCategoryKey[] = ENGINE_BETA_CATEGORIES.map((c) => c.key);
    for (const cat of cats) {
      const board = await computeBoardPayload(admin, date, cat);
      const insertRows = board.rows
        .filter((r) => !excludedGameIds.has(String(r.gameId)))
        .map((r) => ({
          snapshot_id: snapshotId,
          category: cat,
          role: findCategory(cat)!.role,
          player_id: r.playerId,
          mlb_id: r.mlbId,
          player_name: r.name,
          team_abbr: r.teamAbbr,
          game_id: r.gameId,
          game_pk: r.gamePk,
          forecast_run_id: r.forecastRunId,
          shadow_run_id: r.shadowRunId,
          lineup_status: r.lineupState,
          batting_order: r.battingOrder,
          baseline: { mean: r.baselineMean, p50: r.baselineP50, p90: r.baselineP90, probAtThreshold: r.probAtThreshold, eventLabel: r.eventLabel, meanUnit: r.meanUnit, threshold: findCategory(cat)!.threshold },
          shadow: r.shadowMean != null ? { mean: r.shadowMean, delta: r.shadowDelta } : null,
          form: { applied: r.formApplied, reason: r.formReason, headlineEvent: r.formHeadlineEvent, headlineDelta: r.formHeadlineDelta, recentDenominator: r.recentDenominator },
          score: r.score,
          score_components: { ...r.scoreComponents, readiness: r.readiness, readinessReason: r.readinessReason },
          actuals: null,
        }));
      if (insertRows.length) {
        const { error } = await admin.from("engine_beta_snapshot_rows").insert(insertRows);
        if (error) throw new Error(error.message);
        rowsWritten += insertRows.length;
      }
    }

    return { snapshotId, slateDate: date, version, rowsWritten, categories: cats, skippedAutoLockedGames: excludedGameIds.size };
  });

// ============================================================================
// Manual per-game lock ("Lock This Game Now").
// Only allowed for eligible upcoming games; refuses to overwrite any prior
// snapshot for the same game.
// ============================================================================

export type LockGameResult = { snapshotId: string; gameId: string; gamePk: number; rowsWritten: number; mode: "manual_game" };

export const lockSingleGameNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { gameId: string; notes?: string }) => data)
  .handler(async ({ data, context }): Promise<LockGameResult> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;

    const { data: game, error: gameErr } = await admin
      .from("games")
      .select("id, mlb_game_id, first_pitch_at, game_status, date")
      .eq("id", data.gameId)
      .single();
    if (gameErr || !game) throw new Error(gameErr?.message ?? "Game not found");

    // Refuse if the game has already started / is live / final.
    const LIVE_RX = /live|in progress|final|game over|completed|postponed|suspended/i;
    if (game.game_status && LIVE_RX.test(String(game.game_status))) {
      throw new Error(`Cannot manual-lock ${game.mlb_game_id}: game status is "${game.game_status}"`);
    }
    if (game.first_pitch_at && Date.parse(game.first_pitch_at) <= Date.now()) {
      throw new Error(`Cannot manual-lock ${game.mlb_game_id}: first pitch has passed`);
    }

    // Refuse if any snapshot for this game already exists (auto or manual_game).
    const { data: existing } = await admin
      .from("engine_beta_snapshots")
      .select("id, lock_mode")
      .eq("game_id", data.gameId);
    if (existing && existing.length > 0) {
      throw new Error(`Game already has a ${existing[0].lock_mode} snapshot — it is immutable.`);
    }

    const { rowsByCategory, gameRowCount } = await computeGameSnapshotRows(admin, game.date, game.id);
    if (gameRowCount === 0) {
      throw new Error("No eligible rows to lock for this game yet.");
    }

    const { data: snap, error: snapErr } = await admin
      .from("engine_beta_snapshots")
      .insert({
        slate_date: game.date,
        game_id: game.id,
        game_pk: Number(game.mlb_game_id),
        scheduled_first_pitch: game.first_pitch_at,
        lock_mode: "manual_game",
        lock_reason: null,
        created_by: context.userId,
        notes: data.notes ?? null,
        meta: { weights: ENGINE_BETA_WEIGHTS, version: 1, source: "admin_manual_game" },
        data_freshness: null,
      })
      .select("id")
      .single();
    if (snapErr) throw new Error(snapErr.message);
    const snapshotId = snap.id as string;

    const inserts: any[] = [];
    for (const c of ENGINE_BETA_CATEGORIES) {
      for (const row of rowsByCategory[c.key] ?? []) inserts.push({ ...row, snapshot_id: snapshotId });
    }
    if (inserts.length) {
      const { error } = await admin.from("engine_beta_snapshot_rows").insert(inserts);
      if (error) throw new Error(error.message);
    }

    return { snapshotId, gameId: game.id, gamePk: Number(game.mlb_game_id), rowsWritten: inserts.length, mode: "manual_game" };
  });

// ============================================================================
// Per-game lock status (drives the "Today's Lock Status" UI panel).
// ============================================================================

export type GameLockStatus = {
  gameId: string;
  gamePk: number;
  matchup: string;
  firstPitchAt: string | null;
  gameStatus: string | null;
  scheduledStart: string | null;
  hasStarted: boolean;
  eligibleForAutoLock: boolean;
  readyToAutoLock: boolean;
  autoLock: null | { snapshotId: string; createdAt: string; rows: number; missed: boolean; reason: string | null };
  manualLock: null | { snapshotId: string; createdAt: string; rows: number };
  status: "auto_locked" | "manually_locked" | "missed_pregame" | "ready_to_lock" | "not_ready" | "started";
  reason: string;
};

export type LockStatusPayload = {
  date: string;
  now: string;
  lockLeadMinutes: number;
  missedGraceMinutes: number;
  games: GameLockStatus[];
};

export const getEngineBetaLockStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string }) => data)
  .handler(async ({ data, context }): Promise<LockStatusPayload> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;
    const date = data.date ?? todayInAppTz();
    const now = new Date();
    const nowMs = now.getTime();

    const { data: games } = await admin
      .from("games")
      .select("id, mlb_game_id, first_pitch_at, game_status, home_team_id, away_team_id")
      .eq("date", date);
    const gs = games ?? [];
    if (!gs.length) {
      return { date, now: now.toISOString(), lockLeadMinutes: DEFAULT_LOCK_LEAD_MINUTES, missedGraceMinutes: DEFAULT_MISSED_GRACE_MINUTES, games: [] };
    }

    const teamIds = Array.from(new Set(gs.flatMap((g: any) => [g.home_team_id, g.away_team_id]).filter(Boolean)));
    const { data: teams } = teamIds.length
      ? await admin.from("teams").select("id, abbreviation").in("id", teamIds)
      : { data: [] };
    const abbrById = new Map<string, string>((teams ?? []).map((t: any) => [String(t.id), t.abbreviation]));

    const gameIds = gs.map((g: any) => g.id);
    const { data: snaps } = await admin
      .from("engine_beta_snapshots")
      .select("id, game_id, lock_mode, lock_reason, created_at, scheduled_first_pitch")
      .in("game_id", gameIds);
    const rowCounts = new Map<string, number>();
    if (snaps && snaps.length) {
      const snapIds = snaps.map((s: any) => s.id);
      const { data: countRows } = await admin
        .from("engine_beta_snapshot_rows")
        .select("snapshot_id")
        .in("snapshot_id", snapIds);
      for (const r of countRows ?? []) rowCounts.set(String(r.snapshot_id), (rowCounts.get(String(r.snapshot_id)) ?? 0) + 1);
    }
    const autoByGame = new Map<string, any>();
    const manualByGame = new Map<string, any>();
    for (const s of snaps ?? []) {
      if (!s.game_id) continue;
      if (s.lock_mode === "automatic") autoByGame.set(String(s.game_id), s);
      else if (s.lock_mode === "manual_game") manualByGame.set(String(s.game_id), s);
    }

    const forecastByGame = new Map<string, boolean>();
    const { data: runs } = await admin
      .from("forecast_runs")
      .select("game_id")
      .in("game_id", gameIds)
      .eq("slate_date", date);
    for (const r of runs ?? []) forecastByGame.set(String(r.game_id), true);

    const LIVE_RX = /live|in progress|final|game over|completed|postponed|suspended/i;
    const leadMs = DEFAULT_LOCK_LEAD_MINUTES * 60_000;
    const graceMs = DEFAULT_MISSED_GRACE_MINUTES * 60_000;

    const rows: GameLockStatus[] = gs.map((g: any) => {
      const gameId = String(g.id);
      const gamePk = Number(g.mlb_game_id);
      const away = abbrById.get(String(g.away_team_id)) ?? "AWY";
      const home = abbrById.get(String(g.home_team_id)) ?? "HOM";
      const matchup = `${away} @ ${home}`;
      const fp = g.first_pitch_at ? Date.parse(g.first_pitch_at) : NaN;
      const started = (g.game_status && LIVE_RX.test(String(g.game_status))) || (Number.isFinite(fp) && fp <= nowMs);
      const hasForecast = forecastByGame.has(gameId);
      const eligibleForAuto = hasForecast && Number.isFinite(fp);
      const readyToAuto = eligibleForAuto && !started && (fp - nowMs <= leadMs) && (fp - nowMs > -graceMs);
      const auto = autoByGame.get(gameId);
      const manual = manualByGame.get(gameId);

      let status: GameLockStatus["status"];
      let reason: string;
      if (auto && !auto.lock_reason) { status = "auto_locked"; reason = "Automatic pregame snapshot recorded"; }
      else if (auto && auto.lock_reason === "missed_pregame_window") { status = "missed_pregame"; reason = "Pregame window missed — no snapshot"; }
      else if (manual) { status = "manually_locked"; reason = "Manual per-game snapshot recorded"; }
      else if (started) { status = "started"; reason = "Game has begun; pregame lock no longer possible"; }
      else if (!hasForecast) { status = "not_ready"; reason = "No baseline forecast yet"; }
      else if (!Number.isFinite(fp)) { status = "not_ready"; reason = "No scheduled first pitch"; }
      else if (readyToAuto) { status = "ready_to_lock"; reason = "Inside lock window — awaiting orchestrator cycle"; }
      else { status = "not_ready"; reason = `Waits until first pitch minus ${DEFAULT_LOCK_LEAD_MINUTES}m`; }

      return {
        gameId, gamePk, matchup,
        firstPitchAt: g.first_pitch_at ?? null,
        gameStatus: g.game_status ?? null,
        scheduledStart: g.first_pitch_at ?? null,
        hasStarted: started,
        eligibleForAutoLock: eligibleForAuto,
        readyToAutoLock: readyToAuto,
        autoLock: auto ? { snapshotId: auto.id, createdAt: auto.created_at, rows: rowCounts.get(String(auto.id)) ?? 0, missed: !!auto.lock_reason, reason: auto.lock_reason ?? null } : null,
        manualLock: manual ? { snapshotId: manual.id, createdAt: manual.created_at, rows: rowCounts.get(String(manual.id)) ?? 0 } : null,
        status, reason,
      };
    });

    rows.sort((a, b) => (a.firstPitchAt ?? "").localeCompare(b.firstPitchAt ?? ""));
    return { date, now: now.toISOString(), lockLeadMinutes: DEFAULT_LOCK_LEAD_MINUTES, missedGraceMinutes: DEFAULT_MISSED_GRACE_MINUTES, games: rows };
  });

// ============================================================================
// Grading (per-snapshot).
// ============================================================================

export type GradingRow = {
  category: EngineBetaCategoryKey;
  player: string;
  team: string | null;
  score: number;
  bucket: "80-100" | "60-79" | "0-59";
  baselineMean: number | null;
  shadowMean: number | null;
  actual: number | null;
  hit: boolean | null;
};

export type GradingPayload = {
  snapshotId: string | null;
  slateDate: string;
  createdAt: string | null;
  lockMode: string | null;
  totalRows: number;
  gradedRows: number;
  byBucket: Record<"80-100" | "60-79" | "0-59", { total: number; graded: number; hits: number; hitRate: number | null }>;
  byCategory: Record<string, { total: number; graded: number; hits: number; hitRate: number | null; baselineMae: number | null; shadowMae: number | null }>;
  incomplete: boolean;
  rows: GradingRow[];
};

export const getEngineBetaGrading = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { date?: string; snapshotId?: string }) => data)
  .handler(async ({ data, context }): Promise<GradingPayload> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;
    const date = data.date ?? todayInAppTz();

    // Snapshot selection:
    //  - explicit id wins
    //  - otherwise prefer per-game (automatic > manual_game) snapshots across
    //    all games for the slate, aggregated as "the slate's grading"
    //  - fallback to most recent date-wide manual snapshot
    let snapshotIds: string[] = [];
    let headerFor: any = null;
    if (data.snapshotId) {
      const { data: s } = await admin.from("engine_beta_snapshots").select("id, slate_date, created_at, lock_mode").eq("id", data.snapshotId).maybeSingle();
      if (s) { snapshotIds = [s.id]; headerFor = s; }
    } else {
      const { data: perGame } = await admin
        .from("engine_beta_snapshots")
        .select("id, slate_date, created_at, lock_mode, lock_reason, game_id")
        .eq("slate_date", date)
        .not("game_id", "is", null)
        .in("lock_mode", ["automatic", "manual_game"])
        .is("lock_reason", null);
      if (perGame && perGame.length) {
        snapshotIds = perGame.map((s: any) => s.id);
        headerFor = { id: null, slate_date: date, created_at: perGame[0].created_at, lock_mode: "per_game" };
      } else {
        const { data: legacy } = await admin
          .from("engine_beta_snapshots")
          .select("id, slate_date, created_at, lock_mode")
          .eq("slate_date", date)
          .is("game_id", null)
          .order("created_at", { ascending: false })
          .limit(1);
        if (legacy && legacy.length) { snapshotIds = [legacy[0].id]; headerFor = legacy[0]; }
      }
    }

    if (!snapshotIds.length) {
      return { snapshotId: null, slateDate: date, createdAt: null, lockMode: null, totalRows: 0, gradedRows: 0, byBucket: emptyBuckets(), byCategory: {}, incomplete: true, rows: [] };
    }
    const { data: rows } = await admin
      .from("engine_beta_snapshot_rows")
      .select("category, role, player_id, player_name, team_abbr, game_id, baseline, shadow, score")
      .in("snapshot_id", snapshotIds);
    if (!rows?.length) {
      return { snapshotId: headerFor?.id ?? null, slateDate: headerFor?.slate_date ?? date, createdAt: headerFor?.created_at ?? null, lockMode: headerFor?.lock_mode ?? null, totalRows: 0, gradedRows: 0, byBucket: emptyBuckets(), byCategory: {}, incomplete: true, rows: [] };
    }

    const gameIds = Array.from(new Set(rows.map((r: any) => r.game_id).filter(Boolean)));
    const playerIds = Array.from(new Set(rows.map((r: any) => r.player_id).filter(Boolean)));
    const { data: gameRows } = gameIds.length
      ? await admin.from("games").select("id, game_status").in("id", gameIds)
      : { data: [] };
    const gameStatus = new Map((gameRows ?? []).map((g: any) => [String(g.id), g.game_status]));
    const { data: actuals } = playerIds.length && gameIds.length
      ? await admin.from("projection_results").select("*").in("player_id", playerIds).in("game_id", gameIds)
      : { data: [] };
    const actualByKey = new Map((actuals ?? []).map((r: any) => [`${r.game_id}:${r.player_id}`, r]));

    const buckets = emptyBuckets();
    const byCat: GradingPayload["byCategory"] = {};
    let incompleteAny = false;
    const grow: GradingRow[] = [];

    for (const r of rows as any[]) {
      const category = findCategory(r.category as EngineBetaCategoryKey);
      if (!category) continue;
      const g: any = gameStatus.get(String(r.game_id));
      const gameFinal = typeof g === "string" && /final|game over|completed/i.test(g);
      const a: any = actualByKey.get(`${r.game_id}:${r.player_id}`);
      const actualVal = gameFinal && a ? (a[category.actualsField] as number) : null;
      const bucket: GradingRow["bucket"] = r.score >= 80 ? "80-100" : r.score >= 60 ? "60-79" : "0-59";
      buckets[bucket].total += 1;
      const cat = byCat[r.category] ?? (byCat[r.category] = { total: 0, graded: 0, hits: 0, hitRate: null, baselineMae: null, shadowMae: null });
      cat.total += 1;

      let hit: boolean | null = null;
      if (actualVal != null) {
        const over = actualVal > category.threshold;
        hit = category.higherIsBetter ? over : !over;
        buckets[bucket].graded += 1;
        buckets[bucket].hits += hit ? 1 : 0;
        cat.graded += 1;
        cat.hits += hit ? 1 : 0;
      } else if (!gameFinal) {
        incompleteAny = true;
      }

      grow.push({
        category: r.category, player: r.player_name ?? "—", team: r.team_abbr ?? null,
        score: Number(r.score), bucket,
        baselineMean: numOr(r.baseline?.mean), shadowMean: numOr(r.shadow?.mean),
        actual: actualVal, hit,
      });
    }

    for (const b of Object.values(buckets)) b.hitRate = b.graded > 0 ? b.hits / b.graded : null;
    for (const catKey of Object.keys(byCat)) {
      const cat = byCat[catKey];
      cat.hitRate = cat.graded > 0 ? cat.hits / cat.graded : null;
      const catRows = grow.filter((r) => r.category === catKey && r.actual != null);
      if (catRows.length) {
        const bMae = catRows.reduce((s, r) => s + (r.baselineMean != null ? Math.abs(r.baselineMean - r.actual!) : 0), 0) / catRows.length;
        const shadowRows = catRows.filter((r) => r.shadowMean != null);
        const sMae = shadowRows.length
          ? shadowRows.reduce((s, r) => s + Math.abs(r.shadowMean! - r.actual!), 0) / shadowRows.length
          : null;
        cat.baselineMae = +bMae.toFixed(3);
        cat.shadowMae = sMae != null ? +sMae.toFixed(3) : null;
      }
    }

    return {
      snapshotId: headerFor?.id ?? null,
      slateDate: headerFor?.slate_date ?? date,
      createdAt: headerFor?.created_at ?? null,
      lockMode: headerFor?.lock_mode ?? null,
      totalRows: rows.length,
      gradedRows: grow.filter((r) => r.actual != null).length,
      byBucket: buckets,
      byCategory: byCat,
      incomplete: incompleteAny,
      rows: grow,
    };
  });

function numOr(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function emptyBuckets(): GradingPayload["byBucket"] {
  return {
    "80-100": { total: 0, graded: 0, hits: 0, hitRate: null },
    "60-79":  { total: 0, graded: 0, hits: 0, hitRate: null },
    "0-59":   { total: 0, graded: 0, hits: 0, hitRate: null },
  };
}

// ============================================================================
// Snapshot list (recent).
// ============================================================================

export const listEngineBetaSnapshots = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin: any = supabaseAdmin;
    const { data } = await admin
      .from("engine_beta_snapshots")
      .select("id, slate_date, created_at, notes, lock_mode, game_pk, lock_reason")
      .order("created_at", { ascending: false })
      .limit(25);
    return { snapshots: (data ?? []) as Array<{ id: string; slate_date: string; created_at: string; notes: string | null; lock_mode: string; game_pk: number | null; lock_reason: string | null }> };
  });

// Re-export helper used from `autolock.ts` orchestrator path (also useful in tests).
export { tryAutoLockGame };
