
CREATE TABLE public.engine_beta_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slate_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (slate_date, created_at)
);

GRANT SELECT ON public.engine_beta_snapshots TO authenticated;
GRANT ALL ON public.engine_beta_snapshots TO service_role;
ALTER TABLE public.engine_beta_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read engine_beta_snapshots" ON public.engine_beta_snapshots
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TABLE public.engine_beta_snapshot_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES public.engine_beta_snapshots(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('hitter','pitcher')),
  player_id UUID,
  mlb_id INTEGER,
  player_name TEXT,
  team_abbr TEXT,
  game_id UUID,
  game_pk INTEGER,
  forecast_run_id UUID,
  shadow_run_id UUID,
  lineup_status TEXT,
  batting_order INTEGER,
  baseline JSONB,
  shadow JSONB,
  form JSONB,
  score NUMERIC,
  score_components JSONB,
  actuals JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX engine_beta_snapshot_rows_snap_idx ON public.engine_beta_snapshot_rows(snapshot_id);
CREATE INDEX engine_beta_snapshot_rows_cat_idx ON public.engine_beta_snapshot_rows(snapshot_id, category);

GRANT SELECT ON public.engine_beta_snapshot_rows TO authenticated;
GRANT ALL ON public.engine_beta_snapshot_rows TO service_role;
ALTER TABLE public.engine_beta_snapshot_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read engine_beta_snapshot_rows" ON public.engine_beta_snapshot_rows
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));
