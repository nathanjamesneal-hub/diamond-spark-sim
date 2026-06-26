/**
 * requireAppMember — layered authorization for private read server functions.
 *
 * Behavior:
 *   - 401 (Unauthorized) when no/invalid Supabase session bearer is present.
 *   - 403 (Forbidden) when the caller is authenticated but is not an app
 *     member (no row in public.user_roles, checked via public.is_app_member()).
 *
 * On success, context exposes { supabase, userId, claims } — same shape as
 * requireSupabaseAuth, so handlers can use it the same way. `assertAdmin`
 * continues to layer on top of this for operational/admin mutations.
 */
import { createMiddleware } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { getRequest } from "@tanstack/react-start/server";
import type { Database } from "./types";

function unauthorized(): never {
  throw new Response("Unauthorized", { status: 401 });
}

function forbidden(): never {
  throw new Response("Forbidden", { status: 403 });
}

export const requireAppMember = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      // Misconfiguration; treat as auth failure rather than leak details.
      unauthorized();
    }

    const request = getRequest();
    const authHeader = request?.headers?.get("authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) unauthorized();
    const token = authHeader.slice("Bearer ".length).trim();
    if (!token || token.split(".").length !== 3) unauthorized();

    const supabase = createClient<Database>(SUPABASE_URL!, SUPABASE_PUBLISHABLE_KEY!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    });

    const { data: claimsData, error: claimsErr } = await supabase.auth.getClaims(token);
    if (claimsErr || !claimsData?.claims?.sub) unauthorized();

    const { data: isMember, error: memberErr } = await supabase.rpc("is_app_member");
    if (memberErr || isMember !== true) forbidden();

    return next({
      context: {
        supabase,
        userId: claimsData!.claims.sub,
        claims: claimsData!.claims,
      },
    });
  },
);
