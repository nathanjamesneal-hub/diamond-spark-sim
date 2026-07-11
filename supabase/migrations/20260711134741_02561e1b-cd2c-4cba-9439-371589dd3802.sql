
-- Extend sim_jobs / sim_player_outputs with staged-projection metadata
ALTER TABLE public.sim_jobs
  ADD COLUMN IF NOT EXISTS projection_stage TEXT,
  ADD COLUMN IF NOT EXISTS change_reason TEXT,
  ADD COLUMN IF NOT EXISTS input_effective_time TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sim_jobs_projection_stage_chk'
  ) THEN
    ALTER TABLE public.sim_jobs
      ADD CONSTRAINT sim_jobs_projection_stage_chk
      CHECK (projection_stage IS NULL OR projection_stage = ANY (ARRAY[
        'early','updated','lineup_confirmed','final_pregame'
      ]));
  END IF;
END $$;

ALTER TABLE public.sim_player_outputs
  ADD COLUMN IF NOT EXISTS projection_stage TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sim_player_outputs_projection_stage_chk'
  ) THEN
    ALTER TABLE public.sim_player_outputs
      ADD CONSTRAINT sim_player_outputs_projection_stage_chk
      CHECK (projection_stage IS NULL OR projection_stage = ANY (ARRAY[
        'early','updated','lineup_confirmed','final_pregame'
      ]));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sim_jobs_stage_idx
  ON public.sim_jobs (slate_date, projection_stage, status);

-- Per-game / per-slate scheduler state
CREATE TABLE IF NOT EXISTS public.projection_refresh_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slate_date DATE NOT NULL,
  game_id UUID NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  game_pk BIGINT,
  scheduled_first_pitch_at TIMESTAMPTZ,
  current_projection_stage TEXT,
  game_lifecycle_status TEXT NOT NULL DEFAULT 'awaiting_probable_pitchers',
  latest_inputs_hash TEXT,
  latest_sim_job_id UUID,
  pitcher_status TEXT,
  lineup_status TEXT,
  waiting_reason TEXT,
  next_action TEXT,
  last_checked_at TIMESTAMPTZ,
  last_model_update_at TIMESTAMPTZ,
  last_market_update_at TIMESTAMPTZ,
  change_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (slate_date, game_id)
);

GRANT SELECT ON public.projection_refresh_state TO authenticated;
GRANT ALL ON public.projection_refresh_state TO service_role;

ALTER TABLE public.projection_refresh_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins can read projection_refresh_state"
  ON public.projection_refresh_state;
CREATE POLICY "admins can read projection_refresh_state"
  ON public.projection_refresh_state FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS projection_refresh_state_slate_idx
  ON public.projection_refresh_state (slate_date, current_projection_stage);

DROP TRIGGER IF EXISTS projection_refresh_state_touch
  ON public.projection_refresh_state;
CREATE TRIGGER projection_refresh_state_touch
  BEFORE UPDATE ON public.projection_refresh_state
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Audit log for market-only refresh cycles
CREATE TABLE IF NOT EXISTS public.market_refresh_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slate_date DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  considered_games INTEGER NOT NULL DEFAULT 0,
  updated_rows INTEGER NOT NULL DEFAULT 0,
  unchanged_rows INTEGER NOT NULL DEFAULT 0,
  skipped_reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.market_refresh_runs TO authenticated;
GRANT ALL ON public.market_refresh_runs TO service_role;

ALTER TABLE public.market_refresh_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins can read market_refresh_runs"
  ON public.market_refresh_runs;
CREATE POLICY "admins can read market_refresh_runs"
  ON public.market_refresh_runs FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS market_refresh_runs_slate_idx
  ON public.market_refresh_runs (slate_date, started_at DESC);
