
-- Phase 3a: durable worker plumbing + engine_status guardrail.

ALTER TABLE public.sim_jobs
  ADD COLUMN IF NOT EXISTS engine_status TEXT NOT NULL DEFAULT 'scaffold_unvalidated',
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS chunk_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS finalizer_status TEXT;

ALTER TABLE public.sim_jobs
  DROP CONSTRAINT IF EXISTS sim_jobs_engine_status_chk;
ALTER TABLE public.sim_jobs
  ADD CONSTRAINT sim_jobs_engine_status_chk
  CHECK (engine_status IN ('scaffold_unvalidated','validated'));

ALTER TABLE public.sim_player_outputs
  ADD COLUMN IF NOT EXISTS engine_status TEXT NOT NULL DEFAULT 'scaffold_unvalidated';

ALTER TABLE public.sim_player_outputs
  DROP CONSTRAINT IF EXISTS sim_player_outputs_engine_status_chk;
ALTER TABLE public.sim_player_outputs
  ADD CONSTRAINT sim_player_outputs_engine_status_chk
  CHECK (engine_status IN ('scaffold_unvalidated','validated'));

CREATE INDEX IF NOT EXISTS sim_player_outputs_engine_status_idx
  ON public.sim_player_outputs (engine_status, run_status);

-- Durable per-chunk audit trail.
CREATE TABLE IF NOT EXISTS public.sim_job_chunk_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sim_job_id UUID NOT NULL REFERENCES public.sim_jobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running',
  worker_lease_id UUID,
  sim_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sim_job_chunk_runs_status_chk
    CHECK (status IN ('running','completed','failed','timed_out'))
);

GRANT SELECT ON public.sim_job_chunk_runs TO authenticated;
GRANT ALL ON public.sim_job_chunk_runs TO service_role;

ALTER TABLE public.sim_job_chunk_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins can read sim_job_chunk_runs"
  ON public.sim_job_chunk_runs
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS sim_job_chunk_runs_job_idx
  ON public.sim_job_chunk_runs (sim_job_id, chunk_index, attempt);

CREATE INDEX IF NOT EXISTS sim_job_chunk_runs_status_idx
  ON public.sim_job_chunk_runs (status, started_at DESC);

DROP TRIGGER IF EXISTS sim_job_chunk_runs_touch ON public.sim_job_chunk_runs;
CREATE TRIGGER sim_job_chunk_runs_touch
  BEFORE UPDATE ON public.sim_job_chunk_runs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
