-- Lineups
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

-- Player DNA
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

-- Model versions
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

INSERT INTO public.model_versions(version, notes, active)
VALUES ('alpha-0.3', 'Diamond Engine Alpha 0.3: hitter and pitcher projections informed by Monte Carlo game environment.', false)
ON CONFLICT (version) DO UPDATE SET notes = EXCLUDED.notes;

-- Projections (append-only, includes Alpha 0.3 columns)
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
  run_probability numeric,
  pitcher_win_probability numeric,
  quality_start_probability numeric,
  projected_outs numeric,
  environment_agreement numeric,
  projection_role text NOT NULL DEFAULT 'hitter' CHECK (projection_role IN ('hitter','pitcher')),
  game_environment jsonb,
  inputs jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.projections TO anon, authenticated;
GRANT ALL ON public.projections TO service_role;
ALTER TABLE public.projections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Projections public" ON public.projections FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins insert projections" ON public.projections FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE INDEX projections_game_version_idx ON public.projections(game_id, model_version);
CREATE INDEX projections_player_idx ON public.projections(player_id);
CREATE INDEX projections_created_idx ON public.projections(created_at DESC);

-- Projection results
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
  runs integer NOT NULL DEFAULT 0,
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

-- Calibration summary
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