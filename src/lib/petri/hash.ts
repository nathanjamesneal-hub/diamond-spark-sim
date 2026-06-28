/**
 * Isomorphic SHA-256 hashing for Petri input snapshots.
 *
 * Uses Web Crypto (`globalThis.crypto.subtle`), which is available in both
 * Cloudflare workerd and the browser, so this module is safe to ship in the
 * client bundle even though it is only invoked inside server-fn handlers.
 *
 * NOTE: hashing is async because `crypto.subtle.digest` is async; all current
 * Petri call sites are inside async handlers.
 */

/** Canonical JSON: stable key ordering for reproducible hashing. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export async function inputHash(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonical(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return bufToHex(digest);
}

/** Deterministic seed in [0, 2^31) derived from input hash. */
export function seedFromHash(hash: string): number {
  // Take first 8 hex chars
  const n = parseInt(hash.slice(0, 8), 16);
  return n % 0x7fffffff;
}
