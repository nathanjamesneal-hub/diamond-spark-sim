
-- 0) Widen projections.projection_status check to include legacy_unverified
ALTER TABLE public.projections DROP CONSTRAINT IF EXISTS projections_projection_status_check;
ALTER TABLE public.projections
  ADD CONSTRAINT projections_projection_status_check
  CHECK (projection_status IN ('active','superseded','legacy_unverified'));

-- 1) forecast_runs
CREATE TABLE IF NOT EXISTS public.forecast_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_pk integer NOT NULL,
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  slate_date date NOT NULL,
  model_version text NOT NULL,
  version_number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_lineups','published','locked','superseded','legacy_unverified')),
  trigger_reason text NOT NULL,
  input_hash text,
  simulation_seed text,
  material_inputs jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  superseded_by uuid REFERENCES public.forecast_runs(id) ON DELETE SET NULL,
  created_by uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.forecast_runs TO authenticated;
GRANT ALL ON public.forecast_runs TO service_role;
ALTER TABLE public.forecast_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members can read forecast_runs" ON public.forecast_runs
  FOR SELECT TO authenticated USING (public.is_app_member());

CREATE INDEX IF NOT EXISTS forecast_runs_game_status_idx ON public.forecast_runs(game_pk, status);
CREATE INDEX IF NOT EXISTS forecast_runs_slate_idx ON public.forecast_runs(slate_date, status);
CREATE INDEX IF NOT EXISTS forecast_runs_game_id_idx ON public.forecast_runs(game_id);
CREATE UNIQUE INDEX IF NOT EXISTS forecast_runs_game_version_uniq
  ON public.forecast_runs(game_pk, model_version, version_number);
CREATE UNIQUE INDEX IF NOT EXISTS forecast_runs_one_active_uniq
  ON public.forecast_runs(game_pk, model_version) WHERE status IN ('published','locked');

CREATE TRIGGER forecast_runs_touch
  BEFORE UPDATE ON public.forecast_runs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 2) forecast_player_projections
CREATE TABLE IF NOT EXISTS public.forecast_player_projections (
  forecast_run_id uuid NOT NULL REFERENCES public.forecast_runs(id) ON DELETE CASCADE,
  player_id uuid NOT NULL,
  mlb_id integer,
  role text NOT NULL CHECK (role IN ('hitter','pitcher')),
  diamond_score numeric,
  confidence numeric,
  contact_score numeric,
  power_score numeric,
  speed_score numeric,
  pitcher_grade numeric,
  matchup_grade numeric,
  hit_probability numeric,
  total_base_probability numeric,
  hr_probability numeric,
  rbi_probability numeric,
  sb_probability numeric,
  run_probability numeric,
  pitcher_win_probability numeric,
  quality_start_probability numeric,
  projected_outs numeric,
  environment_agreement numeric,
  distributions jsonb,
  inputs jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (forecast_run_id, player_id)
);

GRANT SELECT ON public.forecast_player_projections TO authenticated;
GRANT ALL ON public.forecast_player_projections TO service_role;
ALTER TABLE public.forecast_player_projections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members can read forecast_player_projections" ON public.forecast_player_projections
  FOR SELECT TO authenticated USING (public.is_app_member());

CREATE INDEX IF NOT EXISTS fpp_player_idx ON public.forecast_player_projections(player_id);
CREATE INDEX IF NOT EXISTS fpp_mlb_idx ON public.forecast_player_projections(mlb_id);

-- 3) Mark existing projections written after first pitch as legacy_unverified.
UPDATE public.projections p
SET projection_status = 'legacy_unverified'
FROM public.games g
WHERE p.game_id = g.id
  AND g.first_pitch_at IS NOT NULL
  AND p.created_at > g.first_pitch_at
  AND p.projection_status NOT IN ('superseded','legacy_unverified');
