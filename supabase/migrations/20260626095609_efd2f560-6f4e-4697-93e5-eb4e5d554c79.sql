ALTER TABLE public.projections
  ADD COLUMN IF NOT EXISTS sim_snapshot jsonb;

COMMENT ON COLUMN public.projections.sim_snapshot IS
  'Locked pregame Monte Carlo distribution snapshot per (player, game). Shape: { H:{mean,p50,p90,probAtLeast1,probAtLeast2}, TB, RBI, R, K, HR, outs, BB, ER, win_probability, quality_start_probability, captured_at, model_version, iterations, snapshot_status }';

CREATE INDEX IF NOT EXISTS projections_sim_snapshot_present_idx
  ON public.projections ((sim_snapshot IS NOT NULL));