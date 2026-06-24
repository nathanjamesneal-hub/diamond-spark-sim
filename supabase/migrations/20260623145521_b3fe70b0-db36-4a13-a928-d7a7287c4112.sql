
-- =========================================================
-- Roles
-- =========================================================
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE POLICY "Users can view their own roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins manage roles"
  ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- =========================================================
-- Teams
-- =========================================================
CREATE TABLE public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mlb_team_id integer NOT NULL UNIQUE,
  abbreviation text NOT NULL,
  name text NOT NULL,
  league text,
  division text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.teams TO anon, authenticated;
GRANT ALL ON public.teams TO service_role;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Teams are public" ON public.teams FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins write teams" ON public.teams FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER teams_touch BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- Players
-- =========================================================
CREATE TABLE public.players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mlb_id integer NOT NULL UNIQUE,
  team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  name text NOT NULL,
  position text,
  bats text,
  throws text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.players TO anon, authenticated;
GRANT ALL ON public.players TO service_role;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Players are public" ON public.players FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins write players" ON public.players FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE INDEX players_team_idx ON public.players(team_id);
CREATE TRIGGER players_touch BEFORE UPDATE ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- Games
-- =========================================================
CREATE TABLE public.games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mlb_game_id integer NOT NULL UNIQUE,
  date date NOT NULL,
  home_team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  away_team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  ballpark text,
  weather jsonb,
  game_status text,
  first_pitch_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.games TO anon, authenticated;
GRANT ALL ON public.games TO service_role;
ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Games are public" ON public.games FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins write games" ON public.games FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE INDEX games_date_idx ON public.games(date);
CREATE INDEX games_home_idx ON public.games(home_team_id);
CREATE INDEX games_away_idx ON public.games(away_team_id);
CREATE TRIGGER games_touch BEFORE UPDATE ON public.games
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- Starting pitchers
-- =========================================================
CREATE TABLE public.starting_pitchers (
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, team_id)
);
GRANT SELECT ON public.starting_pitchers TO anon, authenticated;
GRANT ALL ON public.starting_pitchers TO service_role;
ALTER TABLE public.starting_pitchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Starting pitchers are public" ON public.starting_pitchers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins write SP" ON public.starting_pitchers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE INDEX sp_player_idx ON public.starting_pitchers(player_id);
CREATE TRIGGER sp_touch BEFORE UPDATE ON public.starting_pitchers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- Lineups
-- =========================================================
CREATE TABLE public.lineups (
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  batting_order integer NOT NULL CHECK (batting_order BETWEEN 1 AND 9),
  confirmed boolean NOT NULL DEFAULT false,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, player_id)
);
GRANT SELECT ON public.lineups TO anon, authenticated;
GRANT ALL ON public.lineups TO service_role;
ALTER TABLE public.lineups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Lineups are public" ON public.lineups FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins write lineups" ON public.lineups FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE INDEX lineups_game_idx ON public.lineups(game_id);
CREATE INDEX lineups_player_idx ON public.lineups(player_id);
CREATE TRIGGER lineups_touch BEFORE UPDATE ON public.lineups
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- Player DNA
-- =========================================================
CREATE TABLE public.player_dna (
  player_id uuid PRIMARY KEY REFERENCES public.players(id) ON DELETE CASCADE,
  contact numeric NOT NULL DEFAULT 50,
  power numeric NOT NULL DEFAULT 50,
  speed numeric NOT NULL DEFAULT 50,
  discipline numeric NOT NULL DEFAULT 50,
  consistency numeric NOT NULL DEFAULT 50,
  last_recomputed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.player_dna TO anon, authenticated;
GRANT ALL ON public.player_dna TO service_role;
ALTER TABLE public.player_dna ENABLE ROW LEVEL SECURITY;
CREATE POLICY "DNA public" ON public.player_dna FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins write DNA" ON public.player_dna FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER dna_touch BEFORE UPDATE ON public.player_dna
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- Model versions
-- =========================================================
CREATE TABLE public.model_versions (
  version text PRIMARY KEY,
  release_date date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.model_versions TO anon, authenticated;
GRANT ALL ON public.model_versions TO service_role;
ALTER TABLE public.model_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Model versions are public" ON public.model_versions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins write versions" ON public.model_versions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE UNIQUE INDEX model_versions_one_active ON public.model_versions((active)) WHERE active;

INSERT INTO public.model_versions(version, notes, active)
VALUES ('0.1.0', 'Baseline log5-style hitter projection engine.', true)
ON CONFLICT (version) DO NOTHING;

-- =========================================================
-- Projections (append-only)
-- =========================================================
CREATE TABLE public.projections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  model_version text NOT NULL REFERENCES public.model_versions(version) ON DELETE RESTRICT,
  diamond_score numeric,
  contact_score numeric,
  power_score numeric,
  speed_score numeric,
  pitcher_grade numeric,
  matchup_grade numeric,
  confidence numeric,
  hit_probability numeric,
  total_base_probability numeric,
  hr_probability numeric,
  rbi_probability numeric,
  sb_probability numeric,
  inputs jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.projections TO anon, authenticated;
GRANT ALL ON public.projections TO service_role;
ALTER TABLE public.projections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Projections public" ON public.projections FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins insert projections" ON public.projections FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
-- Intentionally no UPDATE or DELETE policy: projections are append-only.
CREATE INDEX projections_game_version_idx ON public.projections(game_id, model_version);
CREATE INDEX projections_player_idx ON public.projections(player_id);
CREATE INDEX projections_created_idx ON public.projections(created_at DESC);

-- =========================================================
-- Projection results
-- =========================================================
CREATE TABLE public.projection_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  hits integer NOT NULL DEFAULT 0,
  total_bases integer NOT NULL DEFAULT 0,
  home_runs integer NOT NULL DEFAULT 0,
  rbis integer NOT NULL DEFAULT 0,
  stolen_bases integer NOT NULL DEFAULT 0,
  walks integer NOT NULL DEFAULT 0,
  strikeouts integer NOT NULL DEFAULT 0,
  plate_appearances integer NOT NULL DEFAULT 0,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, game_id)
);
GRANT SELECT ON public.projection_results TO anon, authenticated;
GRANT ALL ON public.projection_results TO service_role;
ALTER TABLE public.projection_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Results public" ON public.projection_results FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins write results" ON public.projection_results FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE INDEX results_game_idx ON public.projection_results(game_id);

-- =========================================================
-- Calibration summary (materialized in a regular table; refreshed by runCalibration)
-- =========================================================
CREATE TABLE public.calibration_summary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version text NOT NULL REFERENCES public.model_versions(version) ON DELETE CASCADE,
  stat text NOT NULL,
  confidence_bucket text NOT NULL,
  predicted_mean numeric,
  observed_mean numeric,
  brier_score numeric,
  log_loss numeric,
  sample_size integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_version, stat, confidence_bucket)
);
GRANT SELECT ON public.calibration_summary TO anon, authenticated;
GRANT ALL ON public.calibration_summary TO service_role;
ALTER TABLE public.calibration_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Calibration public" ON public.calibration_summary FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins write calibration" ON public.calibration_summary FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
