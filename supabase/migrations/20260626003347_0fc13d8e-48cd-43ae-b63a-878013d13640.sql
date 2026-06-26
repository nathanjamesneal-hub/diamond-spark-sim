
-- 1. Zero-arg member check (reuses existing user_roles + admin role)
CREATE OR REPLACE FUNCTION public.is_app_member()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = auth.uid()
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_app_member() TO authenticated;

-- 2. Replace public SELECT policies with member-only on all baseball data tables
DO $$
DECLARE
  t text;
  pol text;
  tables text[] := ARRAY[
    'calibration_summary','cron_runs','game_lineup_status','games',
    'lineup_sources','lineups','model_versions','player_dna','players',
    'projection_results','projections','starting_pitchers','teams'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- drop existing public SELECT policies
    FOR pol IN
      SELECT policyname FROM pg_policies
       WHERE schemaname='public' AND tablename=t AND cmd='SELECT'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, t);
    END LOOP;
    -- members-only SELECT
    EXECUTE format(
      'CREATE POLICY "Members can read %1$s" ON public.%1$I FOR SELECT TO authenticated USING (public.is_app_member())',
      t
    );
    -- revoke anon grants
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon', t);
  END LOOP;
END $$;

-- 3. Profiles: members only
DROP POLICY IF EXISTS "Profiles are viewable by anyone" ON public.profiles;
CREATE POLICY "Members can view profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (public.is_app_member());

-- 4. Block new signups at the database level
CREATE OR REPLACE FUNCTION public.block_new_signups()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'New account creation is disabled' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS block_new_signups_trigger ON auth.users;
CREATE TRIGGER block_new_signups_trigger
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.block_new_signups();
