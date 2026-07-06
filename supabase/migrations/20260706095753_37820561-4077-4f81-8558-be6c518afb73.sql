-- 1) Expand automation_log status check + add per-stage columns.
ALTER TABLE public.automation_log DROP CONSTRAINT IF EXISTS automation_log_status_check;
ALTER TABLE public.automation_log ADD CONSTRAINT automation_log_status_check
  CHECK (status = ANY (ARRAY['started','ok','skipped','partial','failed','blocked','timed_out']));

ALTER TABLE public.automation_log
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.automation_log(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_progress_at timestamptz,
  ADD COLUMN IF NOT EXISTS records_considered integer,
  ADD COLUMN IF NOT EXISTS records_updated integer;

CREATE INDEX IF NOT EXISTS automation_log_parent_id_idx
  ON public.automation_log(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS automation_log_stage_idx
  ON public.automation_log(slate_date, stage, started_at DESC) WHERE stage IS NOT NULL;

-- 2) DB-backed concurrency lease. One active lease per (job, slate_date).
CREATE TABLE IF NOT EXISTS public.automation_leases (
  job text NOT NULL,
  slate_date date NOT NULL,
  lease_id uuid NOT NULL DEFAULT gen_random_uuid(),
  holder text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (job, slate_date)
);

GRANT SELECT ON public.automation_leases TO authenticated;
GRANT ALL ON public.automation_leases TO service_role;

ALTER TABLE public.automation_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins can read automation leases"
  ON public.automation_leases FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS automation_leases_expires_idx
  ON public.automation_leases(expires_at) WHERE released_at IS NULL;
