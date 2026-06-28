import { createHash } from "node:crypto";

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

export function inputHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Deterministic seed in [0, 2^31) derived from input hash. */
export function seedFromHash(hash: string): number {
  // Take first 8 hex chars
  const n = parseInt(hash.slice(0, 8), 16);
  return n % 0x7fffffff;
}
