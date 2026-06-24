ALTER TABLE public.projections
  ADD COLUMN IF NOT EXISTS run_probability numeric,
  ADD COLUMN IF NOT EXISTS pitcher_win_probability numeric,
  ADD COLUMN IF NOT EXISTS quality_start_probability numeric,
  ADD COLUMN IF NOT EXISTS projected_outs numeric,
  ADD COLUMN IF NOT EXISTS environment_agreement numeric,
  ADD COLUMN IF NOT EXISTS projection_role text NOT NULL DEFAULT 'hitter'
    CHECK (projection_role IN ('hitter', 'pitcher')),
  ADD COLUMN IF NOT EXISTS game_environment jsonb;

ALTER TABLE public.projection_results
  ADD COLUMN IF NOT EXISTS runs integer NOT NULL DEFAULT 0;

INSERT INTO public.model_versions(version, notes, active)
VALUES (
  'alpha-0.3',
  'Diamond Engine Alpha 0.3: hitter and pitcher projections informed by Monte Carlo game environment.',
  false
)
ON CONFLICT (version) DO UPDATE
SET notes = EXCLUDED.notes;
