
-- ============================================================================
-- Lock Reliability + Immutable Grade Writer v1
-- ============================================================================

-- A. Extend games with terminal-state / actual-start columns
ALTER TABLE public.games
  ADD COLUMN IF NOT EXISTS actual_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminal_state_source text,
  ADD COLUMN IF NOT EXISTS terminal_state_evidence jsonb,
  ADD COLUMN IF NOT EXISTS terminal_state_resolved_at timestamptz;

-- B. Extend engine_beta_snapshots with provenance + game-state classification
ALTER TABLE public.engine_beta_snapshots
  ADD COLUMN IF NOT EXISTS engine_status text,
  ADD COLUMN IF NOT EXISTS forecast_version text,
  ADD COLUMN IF NOT EXISTS code_revision text,
  ADD COLUMN IF NOT EXISTS inputs_hash text,
  ADD COLUMN IF NOT EXISTS actual_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS provenance_status text NOT NULL DEFAULT 'legacy_missing',
  ADD COLUMN IF NOT EXISTS calibration_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS game_state_class text;

-- C. lock_jobs — one durable job per (slate_date, game_id)
CREATE TABLE IF NOT EXISTS public.lock_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slate_date date NOT NULL,
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  game_pk bigint NOT NULL,
  scheduled_first_pitch timestamptz NOT NULL,
  preflight_at timestamptz NOT NULL,
  lock_at timestamptz NOT NULL,
  hard_stop_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  claimed_by text,
  lease_until timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  lateness_seconds integer,
  last_error text,
  snapshot_id uuid REFERENCES public.engine_beta_snapshots(id) ON DELETE SET NULL,
  outcome text,
  outcome_reason text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slate_date, game_id)
);
CREATE INDEX IF NOT EXISTS lock_jobs_due_idx ON public.lock_jobs (status, lock_at);
CREATE INDEX IF NOT EXISTS lock_jobs_slate_idx ON public.lock_jobs (slate_date);

GRANT SELECT ON public.lock_jobs TO authenticated;
GRANT ALL ON public.lock_jobs TO service_role;
ALTER TABLE public.lock_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lock_jobs admin read" ON public.lock_jobs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- D. grading_jobs — one per snapshot pending grading
CREATE TABLE IF NOT EXISTS public.grading_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slate_date date NOT NULL,
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES public.engine_beta_snapshots(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING_FINAL',
  attempt_count integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  claimed_by text,
  lease_until timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  grading_run_id uuid,
  excluded_reason text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id)
);
CREATE INDEX IF NOT EXISTS grading_jobs_status_idx ON public.grading_jobs (status);
CREATE INDEX IF NOT EXISTS grading_jobs_slate_idx ON public.grading_jobs (slate_date);

GRANT SELECT ON public.grading_jobs TO authenticated;
GRANT ALL ON public.grading_jobs TO service_role;
ALTER TABLE public.grading_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "grading_jobs admin read" ON public.grading_jobs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- E. grading_runs — one per graded snapshot execution
CREATE TABLE IF NOT EXISTS public.grading_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slate_date date NOT NULL,
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES public.engine_beta_snapshots(id) ON DELETE CASCADE,
  grading_job_id uuid REFERENCES public.grading_jobs(id) ON DELETE SET NULL,
  forecast_version text,
  engine_status text,
  inputs_hash text,
  outcome_source text,
  outcome_ingested_at timestamptz,
  calibration_eligible boolean NOT NULL DEFAULT false,
  provenance_status text NOT NULL DEFAULT 'legacy_missing',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grading_runs_snapshot_idx ON public.grading_runs (snapshot_id);
CREATE INDEX IF NOT EXISTS grading_runs_slate_idx ON public.grading_runs (slate_date);

GRANT SELECT ON public.grading_runs TO authenticated;
GRANT ALL ON public.grading_runs TO service_role;
ALTER TABLE public.grading_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "grading_runs admin read" ON public.grading_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- F. grade_rows — row-level graded outcomes
CREATE TABLE IF NOT EXISTS public.grade_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grading_run_id uuid NOT NULL REFERENCES public.grading_runs(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES public.engine_beta_snapshots(id) ON DELETE CASCADE,
  snapshot_row_id uuid REFERENCES public.engine_beta_snapshot_rows(id) ON DELETE SET NULL,
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  player_id text,
  category text NOT NULL,
  market text,
  event_key text,
  threshold numeric,
  line numeric,
  projected_prob numeric,
  projected_mean numeric,
  actual_value numeric,
  actual_event boolean,
  brier numeric,
  mae numeric,
  signed_error numeric,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grade_rows_run_idx ON public.grade_rows (grading_run_id);
CREATE INDEX IF NOT EXISTS grade_rows_snapshot_idx ON public.grade_rows (snapshot_id);

GRANT SELECT ON public.grade_rows TO authenticated;
GRANT ALL ON public.grade_rows TO service_role;
ALTER TABLE public.grade_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "grade_rows admin read" ON public.grade_rows
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- G. updated_at triggers
CREATE TRIGGER lock_jobs_touch BEFORE UPDATE ON public.lock_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER grading_jobs_touch BEFORE UPDATE ON public.grading_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
