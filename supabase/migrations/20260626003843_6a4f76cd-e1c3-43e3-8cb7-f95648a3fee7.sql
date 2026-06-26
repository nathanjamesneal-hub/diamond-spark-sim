
REVOKE EXECUTE ON FUNCTION public.is_app_member() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.block_new_signups() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.is_app_member() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
