/**
 * Registry of available lineup providers. Adding a source = a new file
 * here + one entry below. Diamond Engine never imports this.
 */
import type { LineupProvider } from "./types";
import { mlbProvider } from "./mlb";
import { rotowireProvider } from "./rotowire";
import { fangraphsProvider } from "./fangraphs";
import { baseballPressProvider } from "./baseball_press";
import { diamondProjectionProvider } from "./diamond_projection";

export const PROVIDERS: LineupProvider[] = [
  mlbProvider,
  rotowireProvider,
  fangraphsProvider,
  baseballPressProvider,
  diamondProjectionProvider,
];

export function providersByTier(): LineupProvider[] {
  return [...PROVIDERS].sort((a, b) => a.tier - b.tier);
}
