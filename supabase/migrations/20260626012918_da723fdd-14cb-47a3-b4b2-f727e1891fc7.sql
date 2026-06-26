
-- Move SECURITY DEFINER auth helpers out of the PostgREST-exposed public schema
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION private.is_app_member()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid())
$$;

REVOKE ALL ON FUNCTION private.has_role(uuid, public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_app_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.has_role(uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_app_member() TO authenticated, service_role;

-- Repoint policies to private.* equivalents
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies
           WHERE schemaname='public' AND (qual LIKE '%is_app_member%' OR qual LIKE '%has_role%'
                                           OR with_check LIKE '%is_app_member%' OR with_check LIKE '%has_role%')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END$$;

-- Recreate policies using private.* helpers
CREATE POLICY "Users can view their own roles" ON public.user_roles FOR SELECT TO authenticated USING ((auth.uid() = user_id) OR private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins manage roles" ON public.user_roles FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Admins write teams" ON public.teams FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write players" ON public.players FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write games" ON public.games FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write SP" ON public.starting_pitchers FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write lineups" ON public.lineups FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write DNA" ON public.player_dna FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write versions" ON public.model_versions FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins insert projections" ON public.projections FOR INSERT TO authenticated WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write results" ON public.projection_results FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write calibration" ON public.calibration_summary FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write lineup sources" ON public.lineup_sources FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write game lineup status" ON public.game_lineup_status FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins write cron runs" ON public.cron_runs FOR ALL TO authenticated USING (private.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (private.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Members can read calibration_summary" ON public.calibration_summary FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read cron_runs" ON public.cron_runs FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read game_lineup_status" ON public.game_lineup_status FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read games" ON public.games FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read lineup_sources" ON public.lineup_sources FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read lineups" ON public.lineups FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read model_versions" ON public.model_versions FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read player_dna" ON public.player_dna FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read players" ON public.players FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read projection_results" ON public.projection_results FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read projections" ON public.projections FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read starting_pitchers" ON public.starting_pitchers FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can read teams" ON public.teams FOR SELECT TO authenticated USING (private.is_app_member());
CREATE POLICY "Members can view profiles" ON public.profiles FOR SELECT TO authenticated USING (private.is_app_member());

-- Drop the public-schema versions that the linter flagged
DROP FUNCTION IF EXISTS public.is_app_member();
DROP FUNCTION IF EXISTS public.has_role(uuid, public.app_role);
