/**
 * Shared helpers for providers — all server-side.
 */
import type { ProviderGameLineup, ProviderSlot } from "./types";

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

export async function mlbFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${MLB_BASE}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`MLB ${res.status}: ${path}`);
  return (await res.json()) as T;
}

export function hashSlots(slots: ProviderSlot[]): string {
  const canon = [...slots]
    .sort((a, b) => a.order - b.order)
    .map((s) => `${s.order}:${s.mlb_id}:${(s.position ?? "").toUpperCase()}`)
    .join("|");
  // Simple FNV-1a 32-bit hash — sufficient for change detection.
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function emptyResult(): ProviderGameLineup[] {
  return [];
}
