-- Diamond V2 form-adjusted Monte Carlo shadow infrastructure.
-- Shadow-only: these tables are not used by public forecast reads.

CREATE TABLE IF NOT EXISTS public.player_recent_game_event_counts (
  game_pk integer NOT NULL,
  game_id uuid REFERENCES public.games(id) ON DELETE SET NULL,
  game_date date NOT NULL,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  mlb_id integer NOT NULL,
  role text NOT NULL CHECK (role IN ('hitter','pitcher')),
  pa numeric,
  bf numeric,
  outs numeric,
  k numeric,
  bb numeric,
  hbp numeric,
  hr numeric,
  h_1b numeric,
  h_2b numeric,
  h_3b numeric,
  source text NOT NULL,
  source_fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_pk, mlb_id, role)
);

CREATE INDEX IF NOT EXISTS player_recent_game_event_counts_date_idx
  ON public.player_recent_game_event_counts (game_date, role);
CREATE INDEX IF NOT EXISTS player_recent_game_event_counts_player_idx
  ON public.player_recent_game_event_counts (player_id, game_date DESC);

ALTER TABLE public.player_recent_game_event_counts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.player_recent_game_event_counts TO service_role;

CREATE TABLE IF NOT EXISTS public.player_recent_event_rates (
  as_of_date date NOT NULL,
  window_days integer NOT NULL DEFAULT 14,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  mlb_id integer NOT NULL,
  role text NOT NULL CHECK (role IN ('hitter','pitcher')),
  pa numeric,
  bf numeric,
  outs numeric,
  k numeric,
  bb numeric,
  hbp numeric,
  hr numeric,
  h_1b numeric,
  h_2b numeric,
  h_3b numeric,
  source text NOT NULL,
  source_fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (as_of_date, window_days, mlb_id, role)
);

CREATE INDEX IF NOT EXISTS player_recent_event_rates_player_idx
  ON public.player_recent_event_rates (player_id, as_of_date DESC);
CREATE INDEX IF NOT EXISTS player_recent_event_rates_role_idx
  ON public.player_recent_event_rates (as_of_date DESC, role);

ALTER TABLE public.player_recent_event_rates ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.player_recent_event_rates TO service_role;

CREATE TABLE IF NOT EXISTS public.monte_carlo_form_shadow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  game_pk integer NOT NULL,
  slate_date date NOT NULL,
  baseline_forecast_run_id uuid NOT NULL REFERENCES public.forecast_runs(id) ON DELETE CASCADE,
  model_version text NOT NULL,
  seed integer NOT NULL,
  iterations integer NOT NULL,
  form_window_days integer NOT NULL DEFAULT 14,
  input_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (baseline_forecast_run_id, model_version, form_window_days)
);

CREATE INDEX IF NOT EXISTS monte_carlo_form_shadow_runs_game_idx
  ON public.monte_carlo_form_shadow_runs (game_id, created_at DESC);
CREATE INDEX IF NOT EXISTS monte_carlo_form_shadow_runs_baseline_idx
  ON public.monte_carlo_form_shadow_runs (baseline_forecast_run_id);

ALTER TABLE public.monte_carlo_form_shadow_runs ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.monte_carlo_form_shadow_runs TO service_role;

CREATE TABLE IF NOT EXISTS public.monte_carlo_form_shadow_player_outputs (
  shadow_run_id uuid NOT NULL REFERENCES public.monte_carlo_form_shadow_runs(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  mlb_id integer,
  role text NOT NULL CHECK (role IN ('hitter','pitcher')),
  baseline_distributions jsonb,
  form_distributions jsonb,
  form_adjustments jsonb,
  actuals jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shadow_run_id, player_id, role)
);

CREATE INDEX IF NOT EXISTS monte_carlo_form_shadow_outputs_player_idx
  ON public.monte_carlo_form_shadow_player_outputs (player_id, role);

ALTER TABLE public.monte_carlo_form_shadow_player_outputs ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.monte_carlo_form_shadow_player_outputs TO service_role;

COMMENT ON TABLE public.player_recent_game_event_counts IS
  'Diamond V2 shadow raw per-game event cache from completed official MLB game feeds/boxscores only.';
COMMENT ON TABLE public.player_recent_event_rates IS
  'Diamond V2 shadow trailing-window raw event-count rollups; labels and scores are intentionally excluded.';
COMMENT ON TABLE public.monte_carlo_form_shadow_runs IS
  'Diamond V2 form-adjusted Monte Carlo shadow runs. Never used by public forecast reads.';
COMMENT ON TABLE public.monte_carlo_form_shadow_player_outputs IS
  'Diamond V2 player-level baseline-vs-form shadow distributions and adjustment metadata.';