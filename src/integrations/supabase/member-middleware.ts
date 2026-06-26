/**
 * requireAppMember — layered authorization for private read server functions.
 *
 * Behavior:
 *   - 401 (Unauthorized) when no/invalid Supabase session bearer is present.
 *   - 403 (Forbidden) when the caller is authenticated but is not an app member
 *     (no row in public.user_roles, checked via public.is_app_member()).
 *
 * On success, context exposes { supabase, userId, claims } — same shape as
 * requireSupabaseAuth, so handlers that already use it can swap with no change.
 *
 * `assertAdmin(context)` continues to be layered on top of this for
 * operational/admin mutations.
 */
import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "./auth-middleware";

export const requireAppMember = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const { data, error } = await context.supabase.rpc("is_app_member");
    if (error || data !== true) {
      throw new Response("Forbidden", { status: 403 });
    }
    return next({ context });
  });
