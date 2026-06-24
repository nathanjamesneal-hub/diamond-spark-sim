import type { LineupProvider } from "./types";

export const baseballPressProvider: LineupProvider = {
  id: "baseball_press",
  tier: 3,
  baseConfidence: 80,
  enabled: false,
  async fetch() {
    return [];
  },
};
