
-- Petri v0.2 Shadow Lab — isolated admin-only shadow simulation system
-- Fully separate from Alpha 0.3. No reuse of existing forecast tables.

CREATE TABLE public.petri_forecast_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  mlb_game_id integer NOT NULL,
  game_date date NOT NULL,
  model_version text NOT NULL DEFAULT 'petri-v0.2-shadow',
  status text NOT NULL CHECK (status IN ('preview','locked','skipped','abstained')),
  seed bigint NOT NULL,
  iterations integer NOT NULL,
  input_hash text NOT NULL,
  input_source_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_completeness jsonb NOT NULL DEFAULT '{}'::jsonb,
  fallbacks jsonb,
  abstention_reasons jsonb,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX petri_runs_game_date_idx ON public.petri_forecast_runs (game_date);
CREATE INDEX petri_runs_game_id_idx ON public.petri_forecast_runs (game_id);
CREATE INDEX petri_runs_status_idx ON public.petri_forecast_runs (status);

CREATE TRIGGER petri_runs_touch BEFORE UPDATE ON public.petri_forecast_runs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

GRANT SELECT ON public.petri_forecast_runs TO authenticated;
GRANT ALL ON public.petri_forecast_runs TO service_role;

ALTER TABLE public.petri_forecast_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read petri runs" ON public.petri_forecast_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins write petri runs" ON public.petri_forecast_runs
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));


CREATE TABLE public.petri_player_market_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.petri_forecast_runs(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  mlb_player_id integer NOT NULL,
  team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('hitter','pitcher')),
  lineup_slot integer CHECK (lineup_slot IS NULL OR (lineup_slot BETWEEN 1 AND 9)),
  is_confirmed_starter boolean,
  -- Hitter metrics
  h_mean numeric, h_p10 numeric, h_p50 numeric, h_p90 numeric, hit_1plus numeric,
  tb_mean numeric, tb_p10 numeric, tb_p50 numeric, tb_p90 numeric, tb_2plus numeric,
  hr_mean numeric, hr_p10 numeric, hr_p50 numeric, hr_p90 numeric, hr_1plus numeric,
  hitter_k_mean numeric, hitter_k_p10 numeric, hitter_k_p50 numeric, hitter_k_p90 numeric,
  pa_mean numeric,
  -- Pitcher metrics
  pk_mean numeric, pk_p10 numeric, pk_p90 numeric,
  outs_mean numeric, outs_p10 numeric, outs_p90 numeric,
  bf_mean numeric,
  source_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_completeness numeric,
  raw_probability_label text NOT NULL DEFAULT 'Shadow raw probability — not yet calibrated',
  calibrated_probability numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX petri_snap_unique ON public.petri_player_market_snapshots (run_id, mlb_player_id, role);
CREATE INDEX petri_snap_run_role_idx ON public.petri_player_market_snapshots (run_id, role);
CREATE INDEX petri_snap_game_idx ON public.petri_player_market_snapshots (game_id);

GRANT SELECT ON public.petri_player_market_snapshots TO authenticated;
GRANT ALL ON public.petri_player_market_snapshots TO service_role;

ALTER TABLE public.petri_player_market_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read petri snaps" ON public.petri_player_market_snapshots
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins write petri snaps" ON public.petri_player_market_snapshots
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
