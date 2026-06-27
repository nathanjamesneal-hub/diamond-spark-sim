CREATE INDEX IF NOT EXISTS forecast_runs_active_official_idx
  ON public.forecast_runs (game_pk, model_version)
  WHERE projection_class = 'official' AND status = 'published';