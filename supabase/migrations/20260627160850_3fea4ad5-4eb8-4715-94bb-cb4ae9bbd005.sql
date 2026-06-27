
CREATE TABLE public.forecast_consensus (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_run_id    uuid NOT NULL REFERENCES public.forecast_runs(id) ON DELETE CASCADE,
  player_id          uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  market             text NOT NULL,
  consensus_version  text NOT NULL,
  consensus_score    numeric(6,2) NOT NULL,
  score_confidence   numeric(6,2) NOT NULL DEFAULT 100,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  input_hash         text NOT NULL,
  components         jsonb NOT NULL DEFAULT '{}'::jsonb,
  weights            jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_components text[] NOT NULL DEFAULT ARRAY[]::text[],
  completeness       jsonb NOT NULL DEFAULT '{}'::jsonb,
  uncertainty        jsonb NOT NULL DEFAULT '{}'::jsonb,
  lineup_state       jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference_meta     jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes              text,
  UNIQUE (forecast_run_id, player_id, market, consensus_version)
);

CREATE INDEX forecast_consensus_run_idx
  ON public.forecast_consensus (forecast_run_id);
CREATE INDEX forecast_consensus_player_market_idx
  ON public.forecast_consensus (player_id, market, consensus_version);
CREATE INDEX forecast_consensus_version_time_idx
  ON public.forecast_consensus (consensus_version, computed_at DESC);

GRANT SELECT ON public.forecast_consensus TO authenticated;
GRANT ALL    ON public.forecast_consensus TO service_role;

ALTER TABLE public.forecast_consensus ENABLE ROW LEVEL SECURITY;

-- Authenticated members can read consensus rows that belong to a parent
-- forecast_run that is currently published or locked AND classed as
-- 'official'. Preview-class consensus is never exposed.
CREATE POLICY "Members read official-published consensus"
  ON public.forecast_consensus
  FOR SELECT
  TO authenticated
  USING (
    public.is_app_member()
    AND EXISTS (
      SELECT 1
      FROM public.forecast_runs fr
      WHERE fr.id = forecast_consensus.forecast_run_id
        AND fr.projection_class = 'official'
        AND fr.status IN ('published', 'locked')
    )
  );

COMMENT ON TABLE public.forecast_consensus IS
  'Consensus v2 — immutable, publication-time scores. Written exactly once by publishForecastIfEligible(); never recomputed on read.';
