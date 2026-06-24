import type { LineupProvider } from "./types";

export const fangraphsProvider: LineupProvider = {
  id: "fangraphs",
  tier: 3,
  baseConfidence: 80,
  enabled: false, // stub until Firecrawl extraction is wired
  async fetch() {
    return [];
  },
};
