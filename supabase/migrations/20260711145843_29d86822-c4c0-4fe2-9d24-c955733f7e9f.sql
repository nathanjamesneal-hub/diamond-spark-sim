
ALTER TABLE public.sim_player_outputs DROP CONSTRAINT IF EXISTS sim_player_outputs_engine_status_chk;
ALTER TABLE public.sim_player_outputs ADD CONSTRAINT sim_player_outputs_engine_status_chk
  CHECK (engine_status = ANY (ARRAY['scaffold_unvalidated'::text, 'diamond_mc_candidate'::text, 'validated'::text]));
ALTER TABLE public.sim_jobs DROP CONSTRAINT IF EXISTS sim_jobs_engine_status_chk;
ALTER TABLE public.sim_jobs ADD CONSTRAINT sim_jobs_engine_status_chk
  CHECK (engine_status = ANY (ARRAY['scaffold_unvalidated'::text, 'diamond_mc_candidate'::text, 'validated'::text]));
