
CREATE TABLE public.automation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job text NOT NULL,
  status text NOT NULL CHECK (status IN ('started','ok','skipped','partial','failed')),
  slate_date date,
  game_pk bigint,
  decision text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.automation_log TO authenticated;
GRANT ALL ON public.automation_log TO service_role;

ALTER TABLE public.automation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins can read automation log"
  ON public.automation_log FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE INDEX automation_log_job_started_idx
  ON public.automation_log (job, started_at DESC);

CREATE INDEX automation_log_slate_date_idx
  ON public.automation_log (slate_date, started_at DESC)
  WHERE slate_date IS NOT NULL;

CREATE INDEX automation_log_game_pk_idx
  ON public.automation_log (game_pk, started_at DESC)
  WHERE game_pk IS NOT NULL;
