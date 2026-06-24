# Diagnosis + Fix: Player DNA Defaults

## Findings

1. **All 328 `player_dna` rows are at the default `(50, 50, 50, 50, 50)`.** Confirmed by `SELECT count(*), sum(CASE WHEN all_fields=50 …)` → `total=328, all_default=328`.
2. **`Import Lineups` only seeds new players with default DNA** (`ingest.functions.ts:202-216`): it inserts a blank `player_dna` row (which falls back to the column default of `50`) for any player without one. It never UPDATEs existing rows and never reads MLB stats.
3. **No process recomputes DNA from MLB stats.** `rg "player_dna|recompute"` finds only the seed in `importLineups`, the read in `runDiamondEngine`, and the read in `getPlayerProjection` — no writer.
4. **`Run Diamond Engine` reads real DNA — but real DNA is the defaults**, so every hitter is fed `contact=power=speed=discipline=consistency=50`. With identical inputs across the slate, the engine produces near-identical Diamond Scores around 50.
5. **Pitcher grades default to 50 too.** In `runDiamondEngine` the opposing-pitcher quality is `100 - oppDna.contact` (line 361), and `oppDna.contact = 50`, so `pitcherQuality = 50` for every matchup. Pitcher cards run through the same DNA lookup and likewise get the default row.

So the model isn't broken — it's being fed neutral inputs.

## Fix (no Diamond Engine formula change)

Add an admin server function `recomputePlayerDNA` + an admin UI button. It updates `player_dna` rows from MLB Stats API season stats. The engine is untouched and will read the recomputed values automatically on the next `Run Diamond Engine`.

### New server fn — `src/lib/ingest.functions.ts`

`recomputePlayerDNA({ season?, onlyMissing?, playerIds? })`:

- Admin-gated like the other ingest fns.
- Resolve `season = season ?? current MLB season` (year of the latest `games.date`, falling back to current year).
- Load target players from `public.players` (filter: `active = true`; optionally restrict to `playerIds` or to rows whose `player_dna.last_recomputed_at IS NULL` when `onlyMissing`).
- For each player, fetch MLB Stats API season totals:
  - Hitters / two-way: `GET /people/{mlb_id}/stats?stats=season&group=hitting&season={year}` (uses existing `mlb()` helper).
  - Pitchers (`position = 'P'`): `GET …&group=pitching&season={year}`.
- Run **with a concurrency cap of 6** to stay polite to statsapi.mlb.com (simple `Promise.all` over batches). Skip players with no MLB stats yet (preseason or call-ups with 0 PA / 0 IP) — leave their row untouched and report as "skipped".
- Upsert `player_dna` (`onConflict: player_id`) with `{ contact, power, speed, discipline, consistency, last_recomputed_at: now }`.

### Stat → 0–100 mapping (input-prep only; engine formulas unchanged)

Mapping uses MLB-typical baselines. Each sub-score = `clamp(50 + slope * (player_rate - league_rate), 1, 99)`. These constants live alongside the new fn as named consts so they're easy to tweak.

**Hitter** (requires `plateAppearances ≥ 50`):
- `BA = hits/atBats`, `K% = strikeOuts/plateAppearances`, `BB% = baseOnBalls/plateAppearances`, `ISO = slg - avg`, `HRrate = homeRuns/plateAppearances`, `SBrate = stolenBases/games`, `triples`, `games`.
- **contact** = blend of `BA` (baseline .245, slope 500) and `1-K%` (baseline .77, slope 200), averaged.
- **power** = blend of `ISO` (baseline .150, slope 600) and `HRrate` (baseline .030, slope 1500).
- **speed** = blend of `SBrate` (baseline .05, slope 600) and `triples/games` (baseline .005, slope 4000).
- **discipline** = blend of `BB%` (baseline .085, slope 500) and `(BB-K)/PA` (baseline -.10, slope 300).
- **consistency** = function of `games` (baseline 60, slope 0.3), clamped — proxy until we have variance data.

**Pitcher** (requires `inningsPitched ≥ 10`):
- `K9 = strikeOuts*9/IP`, `BB9 = baseOnBalls*9/IP`, `HR9 = homeRuns*9/IP`, `IP/start`.
- **contact** ← K9 (baseline 8.5, slope 8) — engine treats lower opponent-side `contact` as worse contact-suppression; we store the pitcher's strikeout strength here so `pitcherQuality = 100 - oppDna.contact` (line 361 of engine) gives elite K-arms a high opposing-pitcher-quality. This matches what the existing engine code already assumes when it labels SP DNA fields the same way (see the existing TODO at line 350).
- **power** = inverted HR9 (baseline 1.2 HR/9, slope -25).
- **speed** = fixed 35 (matches the engine's pitcher default at line 411 — not used meaningfully for pitchers).
- **discipline** = inverted BB9 (baseline 3.2, slope -10).
- **consistency** = IP-per-start (baseline 5.0, slope 8).

All values are clamped to `[1, 99]` so the engine never sees `0` or `100`.

> These are **input prep**, not Diamond Engine math. The engine's contact/power/etc. → projection formulas in `v0_1_0` and `alpha_0_3` are not edited.

### Admin UI — `src/routes/_authenticated/_admin/admin.tsx`

Insert a new op card "Recompute Player DNA" right above "Run Diamond Engine":

- Label: **Recompute Player DNA**
- Desc: "Pulls season stats from MLB Stats API and refreshes contact / power / speed / discipline / consistency for every active player. Run before Run Diamond Engine when DNA looks stale."
- Optional checkbox: **Only players missing DNA** (sends `onlyMissing: true`).
- Button calls `recomputePlayerDNA({ data: { onlyMissing } })`. Returns `{ updated, skipped, errors, season }` summarized in the existing status line.

### Non-goals

- No changes to `src/lib/engines/v0_1_0/engine.ts`, `src/lib/engines/alpha_0_3/engine.ts`, or `src/lib/engines/registry.ts`.
- No changes to Monte Carlo (`src/lib/sim/*`, `src/lib/sim.functions.ts`).
- No schema migration. `player_dna` already has the right columns including `last_recomputed_at`.
- No change to `Run Diamond Engine` — it already reads `player_dna`; once recomputed, it sees real values automatically.

### Verification after build

1. `bunx tsgo --noEmit` passes.
2. From `/admin`: click **Recompute Player DNA**. Expect `updated ≈ 300`, `skipped ≈ small (players with insufficient PA/IP)`.
3. `SELECT count(*) FROM player_dna WHERE NOT (contact=50 AND power=50 AND speed=50 AND discipline=50 AND consistency=50)` → returns most rows.
4. Re-run **Run Diamond Engine** for today's date.
5. Open `/diamond-scores`: Diamond Scores now spread across the 40–95 range; pitcher cards also spread; tier badges populate correctly.
6. `/slate`, `/calibration`, `/admin` still load; both `v0_1_0` and `alpha_0_3` remain in the registry.
