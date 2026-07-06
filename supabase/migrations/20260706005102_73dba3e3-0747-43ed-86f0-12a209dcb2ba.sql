
ALTER TABLE public.engine_beta_snapshots
  ADD COLUMN IF NOT EXISTS game_id uuid REFERENCES public.games(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS game_pk integer,
  ADD COLUMN IF NOT EXISTS scheduled_first_pitch timestamptz,
  ADD COLUMN IF NOT EXISTS lock_mode text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS lock_reason text,
  ADD COLUMN IF NOT EXISTS data_freshness jsonb;

-- Constrain lock_mode values (guard invalid inserts)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'engine_beta_snapshots_lock_mode_chk'
  ) THEN
    ALTER TABLE public.engine_beta_snapshots
      ADD CONSTRAINT engine_beta_snapshots_lock_mode_chk
      CHECK (lock_mode IN ('manual','manual_game','automatic'));
  END IF;
END $$;

-- Only one automatic snapshot per game (idempotent auto-lock)
CREATE UNIQUE INDEX IF NOT EXISTS engine_beta_snapshots_auto_per_game_uidx
  ON public.engine_beta_snapshots (game_id)
  WHERE game_id IS NOT NULL AND lock_mode = 'automatic';

CREATE INDEX IF NOT EXISTS engine_beta_snapshots_slate_date_idx
  ON public.engine_beta_snapshots (slate_date);

CREATE INDEX IF NOT EXISTS engine_beta_snapshot_rows_snapshot_id_idx
  ON public.engine_beta_snapshot_rows (snapshot_id);
