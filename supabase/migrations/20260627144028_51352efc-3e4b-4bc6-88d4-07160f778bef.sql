
ALTER TABLE public.projections
  ADD COLUMN IF NOT EXISTS projection_class text NOT NULL DEFAULT 'preview';

-- Conservatively reclassify ALL existing rows as legacy_unverified.
UPDATE public.projections
SET projection_class = 'legacy_unverified'
WHERE projection_class = 'preview';

ALTER TABLE public.projections
  ALTER COLUMN projection_class SET DEFAULT 'preview';

ALTER TABLE public.projections
  DROP CONSTRAINT IF EXISTS projections_projection_class_check;
ALTER TABLE public.projections
  ADD CONSTRAINT projections_projection_class_check
  CHECK (projection_class IN ('preview', 'official', 'legacy_unverified'));

CREATE INDEX IF NOT EXISTS projections_public_read_idx
  ON public.projections (game_id, projection_class, projection_status)
  WHERE projection_class = 'official' AND projection_status = 'active';
