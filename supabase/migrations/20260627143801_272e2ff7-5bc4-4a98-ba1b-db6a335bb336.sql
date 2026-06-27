
-- Phase 1: Forecast Class distinction
-- forecast_class is orthogonal to status. status remains awaiting|published|locked|superseded.

ALTER TABLE public.forecast_runs
  ADD COLUMN IF NOT EXISTS forecast_class text NOT NULL DEFAULT 'preview';

-- Conservatively reclassify ALL existing rows as legacy_unverified.
-- We have no stored proof that prior runs used official confirmed lineups
-- generated before first pitch, so they cannot be trusted as "official".
UPDATE public.forecast_runs
SET forecast_class = 'legacy_unverified'
WHERE forecast_class = 'preview';

-- Future default should still be 'preview' so a row inserted without an
-- explicit class is the safest possible classification.
ALTER TABLE public.forecast_runs
  ALTER COLUMN forecast_class SET DEFAULT 'preview';

-- Allowed values
ALTER TABLE public.forecast_runs
  DROP CONSTRAINT IF EXISTS forecast_runs_forecast_class_check;
ALTER TABLE public.forecast_runs
  ADD CONSTRAINT forecast_runs_forecast_class_check
  CHECK (forecast_class IN ('preview', 'official', 'legacy_unverified'));

-- Read filter index for public boards.
CREATE INDEX IF NOT EXISTS forecast_runs_public_read_idx
  ON public.forecast_runs (slate_date, forecast_class, status)
  WHERE forecast_class IN ('official') AND status IN ('published', 'locked');

-- At most one ACTIVE official forecast per (game_pk, model_version).
-- Supersede-then-insert must happen in one transaction inside the lifecycle.
CREATE UNIQUE INDEX IF NOT EXISTS forecast_runs_one_active_official_idx
  ON public.forecast_runs (game_pk, model_version)
  WHERE forecast_class = 'official' AND status IN ('published', 'locked');
