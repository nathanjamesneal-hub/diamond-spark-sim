
-- 1. Provenance columns on existing tables
ALTER TABLE public.lock_jobs
  ADD COLUMN IF NOT EXISTS lock_flavor text,
  ADD COLUMN IF NOT EXISTS inputs_hash text,
  ADD COLUMN IF NOT EXISTS sim_job_id uuid,
  ADD COLUMN IF NOT EXISTS projection_stage text,
  ADD COLUMN IF NOT EXISTS lineup_confirmed_home boolean,
  ADD COLUMN IF NOT EXISTS lineup_confirmed_away boolean;

ALTER TABLE public.engine_beta_snapshots
  ADD COLUMN IF NOT EXISTS lock_flavor text,
  ADD COLUMN IF NOT EXISTS sim_job_id uuid,
  ADD COLUMN IF NOT EXISTS projection_stage text;

-- 2. recommendation_runs
CREATE TABLE IF NOT EXISTS public.recommendation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slate_date date NOT NULL,
  state text NOT NULL CHECK (state IN ('LIVE','OFFICIAL')),
  model_version text NOT NULL,
  formula_version text NOT NULL,
  snapshot_id uuid REFERENCES public.engine_beta_snapshots(id) ON DELETE SET NULL,
  game_id uuid REFERENCES public.games(id) ON DELETE SET NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  superseded_by uuid REFERENCES public.recommendation_runs(id) ON DELETE SET NULL,
  candidate_pool_size int NOT NULL DEFAULT 0,
  selected_count int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reco_runs_slate_state ON public.recommendation_runs(slate_date, state, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reco_runs_active_live ON public.recommendation_runs(slate_date) WHERE state='LIVE' AND superseded_at IS NULL;

GRANT SELECT ON public.recommendation_runs TO authenticated;
GRANT ALL ON public.recommendation_runs TO service_role;
ALTER TABLE public.recommendation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reco_runs_read_members" ON public.recommendation_runs FOR SELECT TO authenticated USING (public.is_app_member());

-- 3. recommendation_legs
CREATE TABLE IF NOT EXISTS public.recommendation_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.recommendation_runs(id) ON DELETE CASCADE,
  tier text NOT NULL,          -- best_bet | featured | double | triple | higher_upside | unvalidated_preview | rejected
  rank int,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  game_id uuid REFERENCES public.games(id) ON DELETE SET NULL,
  market text NOT NULL,
  side text NOT NULL,          -- over | under | yes | no
  line numeric,
  sportsbook_price int,
  diamond_probability numeric,
  novig_probability numeric,
  edge_pp numeric,
  expected_value numeric,
  recommendation_score numeric,
  sim_job_id uuid,
  sim_output_id uuid,
  engine_status text,
  projection_stage text,
  uncertainty jsonb NOT NULL DEFAULT '{}'::jsonb,
  form jsonb NOT NULL DEFAULT '{}'::jsonb,
  matchup jsonb NOT NULL DEFAULT '{}'::jsonb,
  why jsonb NOT NULL DEFAULT '{}'::jsonb,
  reject_reason text,
  reject_details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reco_legs_run_tier_rank ON public.recommendation_legs(run_id, tier, rank);
CREATE INDEX IF NOT EXISTS idx_reco_legs_player ON public.recommendation_legs(player_id);

GRANT SELECT ON public.recommendation_legs TO authenticated;
GRANT ALL ON public.recommendation_legs TO service_role;
ALTER TABLE public.recommendation_legs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reco_legs_read_members" ON public.recommendation_legs FOR SELECT TO authenticated USING (public.is_app_member());

-- 4. recommendation_tickets
CREATE TABLE IF NOT EXISTS public.recommendation_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.recommendation_runs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('double','triple','higher_upside')),
  leg_ids uuid[] NOT NULL,
  estimated_combined_probability numeric,
  min_leg_probability numeric,
  min_recommendation_score numeric,
  notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reco_tickets_run ON public.recommendation_tickets(run_id);

GRANT SELECT ON public.recommendation_tickets TO authenticated;
GRANT ALL ON public.recommendation_tickets TO service_role;
ALTER TABLE public.recommendation_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reco_tickets_read_members" ON public.recommendation_tickets FOR SELECT TO authenticated USING (public.is_app_member());
