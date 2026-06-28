
CREATE TABLE public.petri_skill_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.petri_forecast_runs(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  mlb_player_id integer NOT NULL,
  team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('hitter','pitcher')),
  lineup_slot integer CHECK (lineup_slot IS NULL OR (lineup_slot BETWEEN 1 AND 9)),
  is_confirmed_starter boolean,
  side text NOT NULL CHECK (side IN ('home','away')),
  handedness text,
  opposing_hand text,
  profile_version text NOT NULL DEFAULT 'petri-skill-v0.2',
  features jsonb NOT NULL,
  fallbacks jsonb NOT NULL DEFAULT '[]'::jsonb,
  adjustments jsonb NOT NULL DEFAULT '[]'::jsonb,
  base_rates jsonb NOT NULL,
  pa_outcome_rates jsonb NOT NULL,
  data_completeness numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX petri_skill_profiles_run_idx ON public.petri_skill_profiles(run_id);
CREATE INDEX petri_skill_profiles_game_idx ON public.petri_skill_profiles(game_id);
CREATE UNIQUE INDEX petri_skill_profiles_unique_player ON public.petri_skill_profiles(run_id, mlb_player_id, role);

GRANT SELECT ON public.petri_skill_profiles TO authenticated;
GRANT ALL ON public.petri_skill_profiles TO service_role;

ALTER TABLE public.petri_skill_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read petri skill profiles"
  ON public.petri_skill_profiles FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service role manages petri skill profiles"
  ON public.petri_skill_profiles FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
