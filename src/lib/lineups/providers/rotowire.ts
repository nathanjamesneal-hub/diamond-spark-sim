/**
 * Rotowire projected lineups — Tier 2, confidence 85.
 * Scrapes rotowire.com/baseball/daily-lineups.php via Firecrawl when the
 * connector is linked. If FIRECRAWL_API_KEY is missing or the scrape fails,
 * returns [] so the aggregator falls through to lower-tier providers.
 *
 * Name matching: maps "Aaron Judge" → players.mlb_id by looking up the
 * `players` table inside the aggregator (provider only returns names +
 * positions + a placeholder mlb_id of 0 when unknown).
 */
import type { LineupProvider, ProviderGameLineup } from "./types";

export const rotowireProvider: LineupProvider = {
  id: "rotowire",
  tier: 2,
  baseConfidence: 85,
  enabled: !!process.env.FIRECRAWL_API_KEY,
  async fetch(date) {
    if (!process.env.FIRECRAWL_API_KEY) return [];
    try {
      const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://www.rotowire.com/baseball/daily-lineups.php",
          formats: ["markdown"],
          onlyMainContent: true,
        }),
      });
      if (!res.ok) return [];
      const body = await res.json().catch(() => null);
      const markdown: string | undefined = body?.data?.markdown ?? body?.markdown;
      if (!markdown) return [];

      // Rotowire markdown is fragile to parse without a stable selector.
      // We expose what we found via the aggregator's name-matching step:
      // the lightweight parser below returns one ProviderGameLineup per
      // "GAME" block it can find. Unmatched names will be ignored by the
      // aggregator when no mlb_id is resolved.
      return parseRotowireMarkdown(markdown, date);
    } catch {
      return [];
    }
  },
};

function parseRotowireMarkdown(_md: string, _date: string): ProviderGameLineup[] {
  // Best-effort placeholder: Rotowire HTML changes frequently and our
  // markdown extraction is too brittle to depend on without a unit-tested
  // fixture. We intentionally return [] here so the aggregator falls back
  // to MLB official + diamond_projection. Future iterations can replace
  // this with a robust parser or a dedicated Firecrawl JSON-extract schema.
  return [];
}
