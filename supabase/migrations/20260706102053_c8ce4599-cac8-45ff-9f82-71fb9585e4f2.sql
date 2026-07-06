-- Diamond Official Simulation — durable job queue (Phase 1: table only, no workers yet)

CREATE TABLE public.sim_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  game_pk BIGINT NOT NULL,
  slate_date DATE NOT NULL,
  model_version TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  tier TEXT NOT NULL,                 -- '2k' | '20k'
  label TEXT NOT NULL,                -- 'preview' | 'early_slate' | 'confirmed'
  sim_count INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunks_total INTEGER NOT NULL,
  chunks_done INTEGER NOT NULL DEFAULT 0,
  seed TEXT,
  seed_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  material_change_summary JSONB,      -- diff vs previous input hash when applicable
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|completed|failed|cancelled|stale|timed_out
  failure_reason TEXT,
  worker_lease_id UUID,
  worker_lease_expires_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  last_progress_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sim_jobs_tier_chk CHECK (tier IN ('2k','20k')),
  CONSTRAINT sim_jobs_label_chk CHECK (label IN ('preview','early_slate','confirmed')),
  CONSTRAINT sim_jobs_status_chk CHECK (status IN ('queued','running','completed','failed','cancelled','stale','timed_out')),
  CONSTRAINT sim_jobs_sim_count_chk CHECK (sim_count > 0),
  CONSTRAINT sim_jobs_chunks_chk CHECK (chunks_total > 0 AND chunks_done >= 0 AND chunks_done <= chunks_total)
);

GRANT SELECT ON public.sim_jobs TO authenticated;
GRANT ALL ON public.sim_jobs TO service_role;

ALTER TABLE public.sim_jobs ENABLE ROW LEVEL SECURITY;

-- Admin-only read; writes are restricted to the service role and bypass RLS.
CREATE POLICY "admins can read sim_jobs"
  ON public.sim_jobs
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Idempotency: one job per (game, model, hash, tier, label) — re-enqueue is a no-op.
CREATE UNIQUE INDEX sim_jobs_idempotency_uidx
  ON public.sim_jobs (game_id, model_version, inputs_hash, tier, label);

CREATE INDEX sim_jobs_slate_idx ON public.sim_jobs (slate_date, tier, status);
CREATE INDEX sim_jobs_game_idx ON public.sim_jobs (game_id, tier, status, completed_at DESC);
CREATE INDEX sim_jobs_worker_idx ON public.sim_jobs (status, queued_at)
  WHERE status IN ('queued','running');

CREATE TRIGGER sim_jobs_touch
  BEFORE UPDATE ON public.sim_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
