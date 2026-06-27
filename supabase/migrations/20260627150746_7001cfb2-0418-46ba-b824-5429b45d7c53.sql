ALTER TABLE public.forecast_runs RENAME COLUMN forecast_class TO projection_class;

ALTER TABLE public.forecast_runs
  DROP CONSTRAINT IF EXISTS forecast_runs_forecast_class_check;

ALTER TABLE public.forecast_runs
  ADD CONSTRAINT forecast_runs_projection_class_check
  CHECK (projection_class IN ('preview', 'official', 'legacy_unverified'));

DROP INDEX IF EXISTS public.forecast_runs_active_official_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS forecast_runs_active_official_uidx
  ON public.forecast_runs (slate_date, game_pk, model_version)
  WHERE projection_class = 'official' AND status IN ('published', 'locked');