UPDATE public.model_versions SET active = false WHERE active = true AND version <> 'alpha-0.3';
UPDATE public.model_versions SET active = true WHERE version = 'alpha-0.3';