-- Petri v0.2: support automatic preview + official lifecycle, supersession, and idempotency.
-- All changes are additive and isolated to petri_* tables. Alpha 0.3 tables untouched.

-- 1) Allow 'superseded' status so a newer preview/official can replace an older one
--    without overwriting it (prior runs remain immutable).
ALTER TABLE public.petri_forecast_runs
  DROP CONSTRAINT IF EXISTS petri_forecast_runs_status_check;

ALTER TABLE public.petri_forecast_runs
  ADD CONSTRAINT petri_forecast_runs_status_check
  CHECK (status IN ('preview','locked','skipped','abstained','superseded'));

-- 2) Distinguish preview vs official Petri runs (mirrors Alpha's projection_class).
ALTER TABLE public.petri_forecast_runs
  ADD COLUMN IF NOT EXISTS projection_class text NOT NULL DEFAULT 'preview'
    CHECK (projection_class IN ('preview','official'));

CREATE INDEX IF NOT EXISTS petri_runs_class_status_idx
  ON public.petri_forecast_runs (game_id, projection_class, status);

-- 3) Only ONE active official run per game/model. Preview and official can coexist
--    because the partial index is scoped to projection_class='official'.
CREATE UNIQUE INDEX IF NOT EXISTS petri_runs_one_active_official
  ON public.petri_forecast_runs (game_id, model_version)
  WHERE projection_class = 'official' AND status IN ('preview','locked');

-- 4) Idempotency: same (game, model, class, input_hash) cannot produce two active
--    runs. The pipeline still checks first and short-circuits, but this guarantees
--    correctness even if two cron cycles race.
CREATE UNIQUE INDEX IF NOT EXISTS petri_runs_hash_idempotency
  ON public.petri_forecast_runs (game_id, model_version, projection_class, input_hash)
  WHERE status IN ('preview','locked');
