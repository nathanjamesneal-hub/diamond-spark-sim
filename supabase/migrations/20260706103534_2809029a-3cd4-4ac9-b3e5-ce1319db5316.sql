-- Diamond Official Simulation — canonical per-player outputs (Phase 3 schema)

CREATE TABLE public.sim_player_outputs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Provenance
  sim_job_id UUID NOT NULL REFERENCES public.sim_jobs(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  game_pk BIGINT NOT NULL,
  slate_date DATE NOT NULL,
  model_version TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  sim_tier TEXT NOT NULL,              -- '2k' | '20k'
  sim_count INTEGER NOT NULL,          -- completed simulation count backing this row
  run_status TEXT NOT NULL DEFAULT 'completed', -- 'current' | 'stale' | 'completed' (worker sets)

  -- Player identity + context
  player_id UUID NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  player_type TEXT NOT NULL,           -- 'bat' | 'pit'
  team_id UUID REFERENCES public.teams(id),
  opponent_team_id UUID REFERENCES public.teams(id),
  batting_order INTEGER,
  projected_pa NUMERIC,                -- hitter opportunity
  projected_bf NUMERIC,                -- pitcher opportunity
  handedness TEXT,                     -- 'L' | 'R' | 'S'
  opp_handedness TEXT,                 -- opposing SP hand (hitter) or projected opposing bat side mix (pitcher)

  -- Market identity
  market TEXT NOT NULL,                -- '1plus_hit','2plus_hits','total_bases','hr','rbi','runs','sb','k','outs','er','hits_allowed', ...
  threshold NUMERIC,                   -- e.g. 1.5 TB; NULL for boolean markets like '1plus_hit'

  -- Projection outputs
  projected_mean NUMERIC NOT NULL,     -- expected value of the underlying stat
  event_probability NUMERIC NOT NULL,  -- P(event) from the simulated distribution
  baseline_mean NUMERIC NOT NULL,      -- projection with recent_form contribution removed
  baseline_event_probability NUMERIC NOT NULL,
  form_adjustment NUMERIC NOT NULL,    -- projected_mean - baseline_mean
  form_prob_adjustment NUMERIC NOT NULL, -- event_probability - baseline_event_probability

  -- Distribution / percentiles
  percentile_summary JSONB,            -- { p5, p25, p50, p75, p95 } when applicable
  stderr NUMERIC,                      -- monte-carlo standard error of event_probability
  confidence NUMERIC NOT NULL,         -- 0..1 scalar derived from stderr + sample coverage

  -- Recent form + drivers
  form_sample_size INTEGER,            -- PA (hitter) or BF (pitcher) in the recent window
  form_reliability NUMERIC,            -- 0..1 shrinkage weight actually applied
  form_direction TEXT,                 -- 'riser' | 'neutral' | 'faller'
  driver_metadata JSONB NOT NULL DEFAULT '{}'::jsonb, -- { matchup, park, weather, bullpen, form_contributions_by_event }

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sim_player_outputs_type_chk CHECK (player_type IN ('bat','pit')),
  CONSTRAINT sim_player_outputs_tier_chk CHECK (sim_tier IN ('2k','20k')),
  CONSTRAINT sim_player_outputs_status_chk CHECK (run_status IN ('current','stale','completed')),
  CONSTRAINT sim_player_outputs_form_dir_chk CHECK (form_direction IS NULL OR form_direction IN ('riser','neutral','faller')),
  CONSTRAINT sim_player_outputs_prob_chk CHECK (event_probability BETWEEN 0 AND 1 AND baseline_event_probability BETWEEN 0 AND 1),
  CONSTRAINT sim_player_outputs_conf_chk CHECK (confidence BETWEEN 0 AND 1)
);

GRANT SELECT ON public.sim_player_outputs TO authenticated;
GRANT ALL ON public.sim_player_outputs TO service_role;

ALTER TABLE public.sim_player_outputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins can read sim_player_outputs"
  ON public.sim_player_outputs
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- One row per (run, player, market) — prevents partial rewrite duplication.
CREATE UNIQUE INDEX sim_player_outputs_uidx
  ON public.sim_player_outputs (sim_job_id, player_id, market);

-- Leaderboard read paths: "give me the current 20K completed run for a game, by market"
CREATE INDEX sim_player_outputs_game_market_idx
  ON public.sim_player_outputs (game_id, market, run_status, completed_at DESC);

CREATE INDEX sim_player_outputs_slate_market_idx
  ON public.sim_player_outputs (slate_date, market, run_status, sim_tier);

CREATE INDEX sim_player_outputs_player_idx
  ON public.sim_player_outputs (player_id, slate_date);

CREATE INDEX sim_player_outputs_current_hash_idx
  ON public.sim_player_outputs (game_id, inputs_hash, sim_tier)
  WHERE run_status = 'current';
