/**
 * Lock-job scheduler — creates one durable per-game lock_jobs row per
 * scheduled game at slate creation/update time. Idempotent via the
 * UNIQUE(slate_date, game_id) constraint.
 *
 * Cadence timestamps:
 *   preflight_at = scheduled_first_pitch - 10 min
 *   lock_at      = scheduled_first_pitch - 2  min
 *   hard_stop_at = scheduled_first_pitch
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const PREFLIGHT_LEAD_MS = 10 * 60_000;
export const LOCK_LEAD_MS = 2 * 60_000;

export type ScheduleLockJobsResult = {
  slateDate: string;
  scanned: number;
  created: number;
  updated: number;
  skipped_no_first_pitch: number;
  errors: string[];
};

export async function scheduleLockJobsForSlate(
  admin: SupabaseClient<any>,
  slateDate: string,
): Promise<ScheduleLockJobsResult> {
  const result: ScheduleLockJobsResult = {
    slateDate, scanned: 0, created: 0, updated: 0, skipped_no_first_pitch: 0, errors: [],
  };

  const { data: games, error } = await admin
    .from("games")
    .select("id, mlb_game_id, first_pitch_at, date")
    .eq("date", slateDate);
  if (error) {
    result.errors.push(`games load: ${error.message}`);
    return result;
  }

  for (const g of games ?? []) {
    result.scanned += 1;
    if (!g.first_pitch_at) {
      result.skipped_no_first_pitch += 1;
      continue;
    }
    const fpMs = Date.parse(g.first_pitch_at);
    if (!Number.isFinite(fpMs)) {
      result.errors.push(`game ${g.id}: unparseable first_pitch_at`);
      continue;
    }
    const preflight = new Date(fpMs - PREFLIGHT_LEAD_MS).toISOString();
    const lockAt = new Date(fpMs - LOCK_LEAD_MS).toISOString();
    const hardStop = new Date(fpMs).toISOString();

    const { data: existing } = await admin
      .from("lock_jobs")
      .select("id, scheduled_first_pitch, status")
      .eq("slate_date", slateDate)
      .eq("game_id", g.id)
      .maybeSingle();

    if (!existing) {
      const { error: insErr } = await admin.from("lock_jobs").insert({
        slate_date: slateDate,
        game_id: g.id,
        game_pk: g.mlb_game_id,
        scheduled_first_pitch: g.first_pitch_at,
        preflight_at: preflight,
        lock_at: lockAt,
        hard_stop_at: hardStop,
        status: "PENDING",
      });
      if (insErr) result.errors.push(`insert ${g.id}: ${insErr.message}`);
      else result.created += 1;
      continue;
    }

    // Update timestamps only if scheduled_first_pitch changed AND job is still pending.
    if (existing.status === "PENDING" && existing.scheduled_first_pitch !== g.first_pitch_at) {
      const { error: updErr } = await admin
        .from("lock_jobs")
        .update({
          scheduled_first_pitch: g.first_pitch_at,
          preflight_at: preflight,
          lock_at: lockAt,
          hard_stop_at: hardStop,
        })
        .eq("id", existing.id);
      if (updErr) result.errors.push(`update ${g.id}: ${updErr.message}`);
      else result.updated += 1;
    }
  }
  return result;
}
