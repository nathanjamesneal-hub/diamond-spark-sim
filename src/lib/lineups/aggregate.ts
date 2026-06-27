/**
 * Lineup aggregator. Pulls every enabled provider, persists raw snapshots,
 * picks the best slot-by-slot lineup per team, computes a confidence score,
 * and diffs against the stored lineup so callers know which games changed.
 *
 * Never throws — provider failures are reported in `providers` and the rest
 * of the pipeline keeps going. The Diamond Engine consumes the resulting
 * `lineups` and `game_lineup_status` rows; it does not know about providers.
 */
import type {
  LineupProvider,
  ProviderGameLineup,
  ProviderId,
  ProviderRunResult,
  ProviderSlot,
} from "./providers/types";
import { providersByTier } from "./providers";
import { hashSlots } from "./providers/util";

type TeamLineup = { teamId: string; mlb_team_id: number; slots: ProviderSlot[] };

export type AggregateResult = {
  date: string;
  providers: ProviderRunResult[];
  changedGameIds: string[];
  playersChanged: number;
  gamesScanned: number;
};

export async function aggregateLineups(
  date: string,
  options: { providers?: LineupProvider[] } = {},
): Promise<AggregateResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const providers = (options.providers ?? providersByTier()).filter((p) => p.enabled);

  // ---------- 1. Pull from every provider in parallel ----------
  const providerStats: ProviderRunResult[] = [];
  const providerResults = new Map<ProviderId, ProviderGameLineup[]>();

  await Promise.all(
    providers.map(async (p) => {
      const t0 = Date.now();
      try {
        const data = await p.fetch(date);
        providerResults.set(p.id, data);
        providerStats.push({
          id: p.id,
          ok: true,
          count: data.length,
          durationMs: Date.now() - t0,
        });
      } catch (e: any) {
        providerResults.set(p.id, []);
        providerStats.push({
          id: p.id,
          ok: false,
          count: 0,
          durationMs: Date.now() - t0,
          error: e?.message ?? String(e),
        });
      }
    }),
  );

  // ---------- 2. Resolve games + teams + locked games ----------
  const { data: gamesRows } = await supabaseAdmin
    .from("games")
    .select("id, mlb_game_id, home_team_id, away_team_id, game_status, lineups_locked_at")
    .eq("date", date);
  const games = gamesRows ?? [];
  const gameByMlb = new Map(games.map((g: any) => [g.mlb_game_id, g]));

  const { data: teamRows } = await supabaseAdmin
    .from("teams")
    .select("id, mlb_team_id");
  const teamUuidByMlb = new Map(
    (teamRows ?? []).map((t: any) => [t.mlb_team_id, t.id]),
  );

  // ---------- 3. Persist raw provider snapshots (with hash short-circuit) ----------
  const { data: prevSnapshots } = await supabaseAdmin
    .from("lineup_sources")
    .select("game_id, team_id, source, content_hash")
    .in(
      "game_id",
      games.map((g: any) => g.id),
    );
  const prevHash = new Map(
    (prevSnapshots ?? []).map((s: any) => [
      `${s.game_id}:${s.team_id}:${s.source}`,
      s.content_hash,
    ]),
  );

  const snapshotsToUpsert: any[] = [];
  for (const [providerId, results] of providerResults) {
    for (const game of results) {
      const g = gameByMlb.get(game.mlb_game_id);
      if (!g) continue;
      if (g.lineups_locked_at || g.game_status === "Final") continue;

      for (const side of ["home", "away"] as const) {
        const teamLineup = game[side];
        if (!teamLineup) continue;
        const teamId = teamUuidByMlb.get(teamLineup.mlb_team_id);
        if (!teamId) continue;
        const hash = hashSlots(teamLineup.slots);
        const prev = prevHash.get(`${g.id}:${teamId}:${providerId}`);
        if (prev === hash) continue; // no change at the source level

        snapshotsToUpsert.push({
          game_id: g.id,
          team_id: teamId,
          source: providerId,
          payload: teamLineup.slots,
          content_hash: hash,
          imported_at: new Date().toISOString(),
        });
      }
    }
  }
  if (snapshotsToUpsert.length) {
    await supabaseAdmin
      .from("lineup_sources")
      .upsert(snapshotsToUpsert, { onConflict: "game_id,team_id,source" });
  }

  // ---------- 4. Build best lineup per (game, team) ----------
  // Group provider payloads by game.id and team.id
  type Bucket = { providerId: ProviderId; tier: number; slots: ProviderSlot[] };
  const bucketsByGameTeam = new Map<string, Bucket[]>();
  for (const [providerId, results] of providerResults) {
    const provider = providers.find((p) => p.id === providerId)!;
    for (const game of results) {
      const g = gameByMlb.get(game.mlb_game_id);
      if (!g) continue;
      if (g.lineups_locked_at || g.game_status === "Final") continue;
      for (const side of ["home", "away"] as const) {
        const tl = game[side];
        if (!tl) continue;
        const teamId = teamUuidByMlb.get(tl.mlb_team_id);
        if (!teamId) continue;
        const key = `${g.id}:${teamId}`;
        const arr = bucketsByGameTeam.get(key) ?? [];
        arr.push({ providerId, tier: provider.tier, slots: tl.slots });
        bucketsByGameTeam.set(key, arr);
      }
    }
  }

  // For each (game, team), pick the slot with the highest-tier provider's
  // value. Track which provider "won" each slot for confidence + source.
  type ChosenSlot = ProviderSlot & { sourceId: ProviderId; tier: number };
  const chosenByGameTeam = new Map<
    string,
    { slots: ChosenSlot[]; primary: ProviderId; sourceCount: number }
  >();

  for (const [key, buckets] of bucketsByGameTeam) {
    buckets.sort((a, b) => a.tier - b.tier);
    const slotByOrder = new Map<number, ChosenSlot>();
    for (const b of buckets) {
      for (const s of b.slots) {
        if (slotByOrder.has(s.order)) continue;
        slotByOrder.set(s.order, { ...s, sourceId: b.providerId, tier: b.tier });
      }
    }
    const slots = Array.from(slotByOrder.values()).sort((a, b) => a.order - b.order);
    if (!slots.length) continue;

    // Primary source = the source that won the most slots
    const counts = new Map<ProviderId, number>();
    for (const s of slots) counts.set(s.sourceId, (counts.get(s.sourceId) ?? 0) + 1);
    let primary: ProviderId = slots[0].sourceId;
    let max = 0;
    for (const [id, n] of counts) if (n > max) { max = n; primary = id; }

    chosenByGameTeam.set(key, {
      slots,
      primary,
      sourceCount: buckets.length,
    });
  }

  // ---------- 5. Resolve player_id per slot (existing players only) ----------
  // Build the universe of mlb_ids we need to resolve
  const allMlbIds = new Set<number>();
  for (const { slots } of chosenByGameTeam.values())
    for (const s of slots) allMlbIds.add(s.mlb_id);

  const { data: playerRows } = allMlbIds.size
    ? await supabaseAdmin
        .from("players")
        .select("id, mlb_id, name, position")
        .in("mlb_id", Array.from(allMlbIds))
    : { data: [] };
  const playerByMlb = new Map(
    (playerRows ?? []).map((p: any) => [p.mlb_id, p]),
  );

  // Upsert any missing players so MLB ids that providers know about become
  // real rows (Diamond projection relies on existing rows already, MLB
  // returns names so we can upsert).
  const missingMlbIds: number[] = [];
  for (const [key, { slots }] of chosenByGameTeam) {
    const [, teamId] = key.split(":");
    for (const s of slots) {
      if (playerByMlb.has(s.mlb_id)) continue;
      missingMlbIds.push(s.mlb_id);
      // optimistic upsert
      await supabaseAdmin
        .from("players")
        .upsert(
          { mlb_id: s.mlb_id, name: s.name, position: s.position ?? null, team_id: teamId, active: true },
          { onConflict: "mlb_id" },
        );
    }
  }
  if (missingMlbIds.length) {
    const { data: refreshed } = await supabaseAdmin
      .from("players")
      .select("id, mlb_id, name, position")
      .in("mlb_id", missingMlbIds);
    for (const p of refreshed ?? []) playerByMlb.set(p.mlb_id, p);
  }

  // ---------- 6. Diff vs. current lineups + upsert + game_lineup_status ----------
  const gameIds = games.map((g: any) => g.id);
  const { data: existingLineups } = gameIds.length
    ? await supabaseAdmin
        .from("lineups")
        .select("game_id, team_id, player_id, batting_order, lineup_status, lineup_source")
        .in("game_id", gameIds)
    : { data: [] };

  type ExistingSlot = { player_id: string; batting_order: number; lineup_status: string; lineup_source: string };
  const existingByGameTeam = new Map<string, ExistingSlot[]>();
  for (const row of existingLineups ?? []) {
    const k = `${row.game_id}:${row.team_id}`;
    const arr = existingByGameTeam.get(k) ?? [];
    arr.push({
      player_id: row.player_id,
      batting_order: row.batting_order,
      lineup_status: row.lineup_status,
      lineup_source: row.lineup_source,
    });
    existingByGameTeam.set(k, arr);
  }

  const changedGameIds = new Set<string>();
  let playersChanged = 0;
  const lineupRowsToUpsert: any[] = [];

  // Per-game aggregates for game_lineup_status
  const perGameSummary = new Map<
    string,
    {
      hittersSet: number;
      hittersExpected: number;
      primarySources: Map<ProviderId, number>;
      sourceCount: number;
      confidenceRaw: number; // 0..100 (max so far)
      hasMlb: boolean;
      allFromFallback: boolean;
      slotsAgreed: number;
      slotsTotal: number;
    }
  >();

  for (const [key, { slots, primary, sourceCount }] of chosenByGameTeam) {
    const [gameId, teamId] = key.split(":");
    const game = games.find((g: any) => g.id === gameId);
    if (!game) continue;
    if (game.lineups_locked_at || game.game_status === "Final") continue;

    // Existing slots for this team
    const prior = existingByGameTeam.get(key) ?? [];
    const priorByOrder = new Map(prior.map((p) => [p.batting_order, p]));

    const hasMlbSource = slots.some((s) => s.sourceId === "mlb");
    const teamStatus = hasMlbSource ? "confirmed" : "projected";

    let teamChanged = false;
    for (const s of slots) {
      const player = playerByMlb.get(s.mlb_id);
      if (!player?.id) continue;

      const priorSlot = priorByOrder.get(s.order);
      const isNew = !priorSlot || priorSlot.player_id !== player.id;
      const statusChanged = priorSlot && priorSlot.lineup_status !== teamStatus;
      const sourceChanged = priorSlot && priorSlot.lineup_source !== s.sourceId;
      if (isNew || statusChanged || sourceChanged) {
        teamChanged = true;
        playersChanged += 1;
      }

      lineupRowsToUpsert.push({
        game_id: gameId,
        team_id: teamId,
        player_id: player.id,
        batting_order: s.order,
        lineup_status: teamStatus,
        lineup_source: s.sourceId,
        imported_at: new Date().toISOString(),
        confirmed_at: hasMlbSource ? new Date().toISOString() : null,
        confirmed: hasMlbSource, // keep legacy boolean in sync
      });
    }

    if (teamChanged) changedGameIds.add(gameId);

    // Track game-level summary
    const summary =
      perGameSummary.get(gameId) ?? {
        hittersSet: 0,
        hittersExpected: 18,
        primarySources: new Map<ProviderId, number>(),
        sourceCount: 0,
        confidenceRaw: 0,
        hasMlb: false,
        allFromFallback: true,
        slotsAgreed: 0,
        slotsTotal: 0,
      };
    summary.hittersSet += slots.length;
    summary.sourceCount = Math.max(summary.sourceCount, sourceCount);
    summary.primarySources.set(
      primary,
      (summary.primarySources.get(primary) ?? 0) + 1,
    );
    if (hasMlbSource) summary.hasMlb = true;
    summary.slotsTotal += slots.length;
    for (const s of slots) {
      if (s.sourceId !== "diamond_projection") summary.allFromFallback = false;
    }

    // Confidence for this team
    const buckets = bucketsByGameTeam.get(key) ?? [];
    const teamConfidence = computeTeamConfidence(buckets, hasMlbSource);
    if (teamConfidence > summary.confidenceRaw)
      summary.confidenceRaw = teamConfidence;

    perGameSummary.set(gameId, summary);
  }

  if (lineupRowsToUpsert.length) {
    await supabaseAdmin
      .from("lineups")
      .upsert(lineupRowsToUpsert, { onConflict: "game_id,player_id" });
  }

  // ---------- 6b. Drop orphan projected rows on MLB-confirmed teams ----------
  // Once MLB confirms a lineup, any previously persisted projected row for
  // that (game, team) is stale. They linger because the upsert key is
  // (game_id, player_id) — projected rows reference *different* player_ids
  // than the confirmed MLB ones. Leaving them in place breaks official
  // forecast eligibility (which forbids any non-confirmed / projected rows
  // on a team) and inflates lineup counts past 9.
  const confirmedTeamKeys: Array<{ game_id: string; team_id: string }> = [];
  const seenKey = new Set<string>();
  for (const row of lineupRowsToUpsert) {
    if (!row.confirmed) continue;
    const k = `${row.game_id}:${row.team_id}`;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    confirmedTeamKeys.push({ game_id: row.game_id, team_id: row.team_id });
  }
  for (const { game_id, team_id } of confirmedTeamKeys) {
    await supabaseAdmin
      .from("lineups")
      .delete()
      .eq("game_id", game_id)
      .eq("team_id", team_id)
      .in("lineup_source", [
        "projected",
        "rotowire",
        "projection",
        "draftkings_projected",
        "diamond_projection",
      ]);
  }

  // ---------- 7. Upsert game_lineup_status ----------
  const statusRows: any[] = [];
  for (const [gameId, summary] of perGameSummary) {
    let primary: ProviderId = "diamond_projection";
    let max = 0;
    for (const [id, n] of summary.primarySources) if (n > max) { max = n; primary = id; }
    statusRows.push({
      game_id: gameId,
      status: summary.hasMlb ? "confirmed" : "projected",
      confidence: summary.confidenceRaw,
      primary_source: primary,
      source_count: summary.sourceCount,
      hitters_set: summary.hittersSet,
      hitters_expected: 18,
      last_refresh_at: new Date().toISOString(),
    });
  }
  if (statusRows.length) {
    await supabaseAdmin
      .from("game_lineup_status")
      .upsert(statusRows, { onConflict: "game_id" });
  }

  return {
    date,
    providers: providerStats,
    changedGameIds: Array.from(changedGameIds),
    playersChanged,
    gamesScanned: games.length,
  };
}

function computeTeamConfidence(
  buckets: { providerId: ProviderId; tier: number; slots: ProviderSlot[] }[],
  hasMlb: boolean,
): number {
  if (hasMlb) return 100;
  if (!buckets.length) return 0;
  const hasRotowire = buckets.some((b) => b.providerId === "rotowire");
  const has2OrMoreNonFallback = buckets.filter((b) => b.providerId !== "diamond_projection").length >= 2;
  const onlyFallback = buckets.every((b) => b.providerId === "diamond_projection");

  if (hasRotowire && has2OrMoreNonFallback) return 95;
  if (has2OrMoreNonFallback) return 90;
  if (hasRotowire) return 85;
  const tier2or3 = buckets.find((b) => b.tier === 2 || b.tier === 3);
  if (tier2or3) return 80;
  if (onlyFallback) return 65;
  return 70;
}
