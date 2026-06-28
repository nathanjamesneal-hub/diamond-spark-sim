INSERT INTO public.model_versions (version, release_date, notes, active)
VALUES (
  'alpha-0.3.1-sample-shrink',
  CURRENT_DATE,
  'Alpha 0.3 + Bayesian small-sample shrinkage at input-profile layer (HITTER_FULL_TRUST_PA=300/MAX_PRIOR=250, PITCHER_FULL_TRUST_BF=500/MAX_PRIOR=400). Runs (R) unavailable — batter runs only credited on HR.',
  false
)
ON CONFLICT (version) DO UPDATE SET notes = EXCLUDED.notes;

UPDATE public.model_versions SET active = false WHERE active AND version <> 'alpha-0.3.1-sample-shrink';
UPDATE public.model_versions SET active = true WHERE version = 'alpha-0.3.1-sample-shrink';