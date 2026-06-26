/**
 * Supabase Before-User-Created Auth Hook.
 *
 * Configured in Supabase Auth as the HTTP "Before User Created" hook so every
 * new auth.users insertion (signup via email, OAuth first-time identity, magic
 * link, etc.) is sent here for verdict. This implementation rejects every
 * request — sign-ups are disabled for this private app.
 *
 * The existing admin owner is unaffected because the hook only fires on
 * NEW user creation; they already exist in auth.users.
 *
 * Standard Webhooks signature verification:
 *   headers: webhook-id, webhook-timestamp, webhook-signature ("v1,<base64-hmac>")
 *   signed input: `${id}.${timestamp}.${rawBody}`
 *   secret: BEFORE_USER_CREATED_HOOK_SECRET (base64-encoded, stored server-only)
 *
 * Rejection payload uses the documented Auth Hook envelope so Supabase Auth
 * surfaces it as a 4xx to the caller without creating the user row.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

const REJECTION = {
  error: {
    http_code: 403,
    message: "Sign-ups are disabled for this app.",
  },
} as const;

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

function verifySignature(opts: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
  signatureHeader: string;
}): boolean {
  // Standard Webhooks secrets are prefixed `v1,whsec_<base64>`; Supabase
  // surfaces only the base64 part after `whsec_`.
  let secret = opts.secret;
  if (secret.startsWith("v1,whsec_")) secret = secret.slice("v1,whsec_".length);
  else if (secret.startsWith("whsec_")) secret = secret.slice("whsec_".length);
  const key = Buffer.from(secret, "base64");
  const signed = `${opts.id}.${opts.timestamp}.${opts.body}`;
  const expected = createHmac("sha256", key).update(signed).digest("base64");
  // Header looks like "v1,<sig> v1,<sig2>" — accept any matching version.
  const parts = opts.signatureHeader.split(" ").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const sig = part.startsWith("v1,") ? part.slice(3) : part;
    if (sig.length !== expected.length) continue;
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export const Route = createFileRoute("/api/public/hooks/before-user-created")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.BEFORE_USER_CREATED_HOOK_SECRET ?? "";
        const sigHeader = request.headers.get("webhook-signature") ?? "";
        const id = request.headers.get("webhook-id") ?? "";
        const ts = request.headers.get("webhook-timestamp") ?? "";
        const body = await request.text();

        if (!secret || !sigHeader || !id || !ts) {
          // Fail-closed: if the secret isn't configured yet, still reject —
          // Supabase Auth interprets a 4xx as "do not create user".
          return Response.json(REJECTION, { status: 403 });
        }
        if (!verifySignature({ secret, id, timestamp: ts, body, signatureHeader: sigHeader })) {
          return unauthorized();
        }

        return Response.json(REJECTION, { status: 200 });
        // Note: Supabase Auth expects the hook to respond 200 with an `error`
        // body to abort user creation; non-2xx is treated as a server error.
      },
    },
  },
});
