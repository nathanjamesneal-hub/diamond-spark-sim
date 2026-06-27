-- Allow OFFICIAL and PREVIEW forecast_runs to coexist for the same
-- (game_pk, model_version). The two legacy class-agnostic unique indexes
-- were blocking official inserts whenever a preview row already existed.

-- 1) Class-scoped version uniqueness (instead of class-agnostic).
DROP INDEX IF EXISTS public.forecast_runs_game_version_uniq;
CREATE UNIQUE INDEX forecast_runs_game_version_class_uniq
  ON public.forecast_runs (game_pk, model_version, projection_class, version_number);

-- 2) Class-scoped "one active" uniqueness. The official-only partial index
--    (forecast_runs_one_active_official_idx) already exists and stays.
--    Add the matching preview-only one and drop the class-agnostic blocker.
DROP INDEX IF EXISTS public.forecast_runs_one_active_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS forecast_runs_one_active_preview_idx
  ON public.forecast_runs (game_pk, model_version)
  WHERE (projection_class = 'preview' AND status IN ('published','locked'));