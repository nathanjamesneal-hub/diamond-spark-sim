## Goal

Modular multi-source **lineup aggregation** + **event-driven Diamond Engine**: a cron heartbeat refreshes data every 15 min during lineup hours, but the engine only runs when something actually changes — and only for the games that changed. No edits to Diamond Engine formulas, Monte Carlo, registry, or calibration.

## Database (one migration)

Schema additions (all existing rows kept; engine-facing tables only get new columns):

`**lineups**` — add `lineup_status text not null default 'projected'` check in (`projected`,`confirmed`,`locked`), `lineup_source text not null default 'mlb'`, `imported_at timestamptz not null default now()`, `confirmed_at timestamptz null`. Backfill `confirmed=true` rows → `status='confirmed'`, `source='mlb'`. Keep `confirmed` column for compat.

`**lineup_sources**` (new) — raw per-source snapshots, never overwritten by other sources. `(game_id, team_id, source)` unique. `payload jsonb` = ordered slots `[{mlb_id,name,position,order}]`, `imported_at`, `content_hash text` so we can short-circuit "same payload".

`**game_lineup_status**` (new) — one row per `game_id`: `status`, `confidence smallint`, `primary_source`, `source_count`, `hitters_set`, `hitters_expected default 9`, `last_refresh_at`, `notes jsonb`.

`**projections**` — add `lineup_status text default 'projected'`, `lineup_source text`, `lineup_confidence smallint`, `projection_status text not null default 'active'` (`active` | `superseded`). Index `(game_id, projection_status, created_at desc)`.

`**games**` — add `lineups_locked_at timestamptz null` for fast locked reads.

`**cron_runs**` (new audit log) — `id`, `started_at`, `finished_at`, `duration_ms`, `providers jsonb` (per-provider `{ok,count,error?}`), `games_changed int`, `players_changed int`, `projections_regenerated int`, `affected_game_ids uuid[]`, `engine_ran bool`, `error text null`, `notes text null`. Index on `started_at desc`. RLS: public select (so the admin panel can read), admin write.

All new tables get GRANTs and policies matching the existing pattern.

Enable extensions in the same migration: `create extension if not exists pg_cron; create extension if not exists pg_net;`.

## Provider interface (modular)

`src/lib/lineups/providers/types.ts`:

```ts
export type ProviderSlot = { mlb_id: number; name: string; position?: string; order: number };
export type ProviderTeamLineup = { mlb_team_id: number; slots: ProviderSlot[] };
export type ProviderGameLineup = {
  mlb_game_id: number; date: string;
  home?: ProviderTeamLineup; away?: ProviderTeamLineup;
  scratches?: number[];
};
export interface LineupProvider {
  id: "mlb" | "rotowire" | "fangraphs" | "baseball_press" | "diamond_projection" | "manual";
  tier: 1 | 2 | 3 | 4;
  baseConfidence: number;
  enabled: boolean;
  fetch(date: string): Promise<ProviderGameLineup[]>;
}
```

Providers (each ~100 LoC, hot-swappable via the registry):

- `mlb.ts` — MLB Stats API boxscore (current logic extracted), tier 1, conf 100.
- `rotowire.ts` — Firecrawl scrape of `rotowire.com/baseball/daily-lineups.php`, tier 2, conf 85.
- `fangraphs.ts` — Firecrawl, tier 3, conf 80. Disabled flag if scrape fails twice.
- `baseball_press.ts` — Firecrawl, tier 3, conf 80. Stub-able.
- `diamond_projection.ts` — tier 4, conf 60–75: probable starter + last 5 games' lineups + active roster.
- `manual.ts` — admin paste form.

`src/lib/lineups/providers/index.ts` exports `PROVIDERS: LineupProvider[]`. Adding a source = new file + one array entry, zero engine churn.

## Aggregator + change detection

`src/lib/lineups/aggregate.ts`:

1. Run enabled providers in parallel (`Promise.allSettled`). Each failure → `cron_runs.providers[id]={ok:false,error}`, never throws.
2. Skip games where `lineups.lineup_status='locked'` or `games.game_status='Final'`.
3. Compute `content_hash` per `(game_id, team_id, source)`. If hash matches stored row → no DB write for that snapshot.
4. Write/refresh `lineup_sources`.
5. For each team build the best slot-by-slot lineup (highest tier wins per slot; falls back through tiers).
6. Confidence:
  - MLB present → **100**, `status='confirmed'`.
  - Rotowire full + matches probable starter → **95**.
  - ≥2 sources agree on ≥7 slots → **90**.
  - Single tier-2/3 full lineup → **80**.
  - Backfill via `diamond_projection` → **60–75** scaled by # fallback slots.
7. **Diff vs. current `lineups` rows** for that game. Build per-game change record: `{batting_order_changes[], scratched[], added[], position_changes[]}`. A game is "changed" iff that record is non-empty *or* `game_lineup_status.status` flips (projected→confirmed, etc.) *or* the probable pitcher for that game changed.
8. Upsert `lineups` only for slots that changed. Upsert `game_lineup_status`.
9. Return `{ changedGameIds, playersChanged, providerStats, pitcherChanges }`.

## Refresh runner (single entrypoint for cron + admin button)

`src/lib/lineups/refresh.functions.ts` → server fn `refreshLineupsAndProject({ date })`:

1. Insert a `cron_runs` row with `started_at=now()`.
2. Run aggregator (steps above) — this also refreshes `lineup_sources`, `game_lineup_status`, `lineups`.
3. Run probable-pitcher refresh (existing `importStartingPitchers` logic, extracted to a helper), capture pitcher diffs → merge into `changedGameIds`.
4. Refresh `games.game_status` + postponements from MLB schedule; if a game flips to `Final` or postponed, drop it from `changedGameIds`.
5. **If `changedGameIds.length === 0**` → finish run, log "No lineup changes detected", `engine_ran=false`. Return.
6. Otherwise: mark `projections` rows for those `game_id`s where `projection_status='active'` → `'superseded'`. Run existing `runDiamondEngine` **only with those `gameIds**` (extend its signature with optional `gameIds?: string[]`). New rows inherit `lineup_status`/`source`/`confidence` from `game_lineup_status`. Count `projections_regenerated`.
7. Update the `cron_runs` row with finished_at, duration_ms, providers stats, counts, affected_game_ids, engine_ran=true.

Engine math, registry, calibration untouched — we only constrain which games it processes.

## Public cron endpoint

`src/routes/api/public/hooks/refresh-lineups.ts` (TanStack server route, no auth middleware — `/api/public/*` bypasses auth at the edge, and we verify the `apikey` header against the project anon key inside the handler).

Body: `{}`. The handler calls `refreshLineupsAndProject({ date: todayIso() })` (uses Eastern-time slate date helper already in `src/lib/timezone.ts`).

**Time gating happens in SQL, not the handler** so the route stays cheap and idempotent: the cron schedule fires only during the lineup window. If something invokes the endpoint outside hours, it still runs (cheap no-op when nothing changed).

## pg_cron schedule (via `supabase--insert`, not migration)

Every 15 minutes from **9:00 AM – 9:00 PM Eastern**, daily. UTC equivalents (Standard Time → 14–02 UTC; DST → 13–01 UTC) — pick a wide window: `*/15 13-2 * * *` is parsed by pg_cron as cross-midnight. Cleaner: two jobs, `*/15 13-23 * * *` and `*/15 0-2 * * *`, so it's unambiguous in both DST regimes.

Job body:

```sql
select net.http_post(
  url := 'https://project--0bdb12d7-3e43-4610-acad-1ad94d39b71d.lovable.app/api/public/hooks/refresh-lineups',
  headers := jsonb_build_object('Content-Type','application/json','apikey','<anon-key>'),
  body := '{}'::jsonb
);
```

## Admin UI

`src/routes/_authenticated/_admin/admin.tsx` gains:

**Manual buttons** (in pipeline order):

1. Import Schedule  2. Refresh Probable Pitchers  3. Refresh Projected Lineups  4. Recompute Player DNA  5. Import Confirmed MLB Lineups  6. **Refresh Now** (calls `refreshLineupsAndProject`, same path as cron)  7. Run Diamond Engine (full slate — kept for emergencies)  8. Lock Lineups  9. Manual paste form.

**Cron Status panel** (new, top of admin page) — `useSuspenseQuery` against new server fn `getCronStatus()` that returns:

- Last successful `cron_runs` row → timestamps, providers status badges, games_changed, players_changed, projections_regenerated, duration_ms, engine_ran.
- Next scheduled refresh: computed client-side from the cron expression `*/15` within the window (no extra DB call).
- Last Diamond Engine run = most-recent `cron_runs.engine_ran=true`.
- Last 20 runs in a collapsible table with errors highlighted.

Auto-refresh the panel every 60 s via React Query `refetchInterval`.

## Display layer (`/diamond-scores`, `/slate`, player cards)

Read-side changes only — no projection-shape break.

- `getDiamondScores` filters `projection_status='active'` and joins `game_lineup_status` for `lineup_status`, `lineup_confidence`, `primary_source`, `hitters_set`, `last_refresh_at`.
- Card badge: 🟢 `Official MLB` (≥95) / 🟡 `Aggregated · {source}` (75–94) / 🟠 `Low confidence` (<75) / 🔒 `Locked`.
- Card subline: `Conf {N} · src: {primary} · {N} sources · updated {relative}`.
- Game header on `/slate`: `{hitters_set}/9 hitters · Conf {N} · refreshed {relative}`.
- Slate progress bar: `{games conf≥95} / {totalGames} games confirmed`.
- Filter chips: All / Official / Aggregated / Low Confidence / Locked (search-param backed).

## Audit & history

- Every projection row carries `model_version`, `created_at`, `inputs`, plus new `lineup_status`/`source`/`confidence` and `projection_status`. Re-runs never delete.
- `cron_runs` is the single source of truth for "why did projections change at 11:30?".
- `lineup_sources` keeps every raw provider snapshot for reproducibility.

## Validation

1. Trigger `Refresh Now` with no lineup changes → `cron_runs` row says `engine_ran=false`, no new `projections` rows.
2. Manually mutate one player's `batting_order` in `lineup_sources` (simulate) then refresh → exactly one game in `changedGameIds`, one engine run, prior `projections` flipped to `superseded`.
3. Disable Rotowire env → aggregator still produces lineups via `diamond_projection`, badges go 🟠.
4. Wait for a real MLB lineup → confidence flips to 100, badge to 🟢, only that game re-projects.
5. Mark a game `Final` → next cron skips it, no churn.
6. Lock past date → 🔒, writes rejected, cron skips.
7. Cron Status panel shows last run, durations, per-provider statuses, last engine run.
8. `/calibration` still loads (columns only added).

## Out of scope

- Engine math (`src/lib/engines/**`), Monte Carlo, registry, calibration weights.
- Per-user OAuth, third-party billing.
- Replacing the `lineups.confirmed` boolean (kept for back-compat; new code reads `lineup_status`).
  If every external provider fails:
  DO NOT fail the refresh.
  Fallback automatically to:
  1. MLB official (if available)
  2. Diamond Projection provider
  3. Existing stored lineup
  Diamond Engine should always have a lineup to project.
  Never stop the pipeline because one provider fails.