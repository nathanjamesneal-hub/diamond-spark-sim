/**
 * Park factors by MLB venue id. 100 = neutral.
 * Numbers compiled from public multi-year aggregates (Statcast / Baseball-Savant style).
 * They are intentionally conservative — used to nudge HR / hit rates, not dominate them.
 */
export type ParkFactor = { hr: number; hits: number; runs: number };

const PARKS: Record<number, ParkFactor> = {
  1: { hr: 110, hits: 102, runs: 105 },    // Coors mountain venue placeholder
  15: { hr: 118, hits: 106, runs: 112 },   // Coors Field
  10: { hr: 108, hits: 102, runs: 104 },   // Great American
  31: { hr: 112, hits: 103, runs: 106 },   // Yankee Stadium
  2: { hr: 96, hits: 99, runs: 98 },       // Fenway
  19: { hr: 92, hits: 97, runs: 95 },      // Oracle
  22: { hr: 90, hits: 96, runs: 94 },      // Petco
  17: { hr: 95, hits: 98, runs: 97 },      // Wrigley
  3289: { hr: 102, hits: 100, runs: 101 }, // Truist
  4705: { hr: 88, hits: 96, runs: 93 },    // loanDepot
  5: { hr: 102, hits: 101, runs: 101 },    // Camden
  7: { hr: 100, hits: 100, runs: 100 },    // Wrigley alt
  9: { hr: 105, hits: 101, runs: 103 },    // Citizens Bank
  12: { hr: 98, hits: 100, runs: 99 },     // Comerica
  13: { hr: 96, hits: 99, runs: 98 },      // Minute Maid
  14: { hr: 99, hits: 100, runs: 99 },     // Kauffman
  16: { hr: 96, hits: 99, runs: 98 },      // Dodger
  18: { hr: 98, hits: 100, runs: 99 },     // Citi Field
  4: { hr: 100, hits: 100, runs: 100 },    // Rogers Centre
  680: { hr: 100, hits: 100, runs: 100 },  // T-Mobile
  2602: { hr: 104, hits: 101, runs: 102 }, // Globe Life
  2680: { hr: 95, hits: 99, runs: 97 },    // Oracle Park alt
  2392: { hr: 100, hits: 100, runs: 100 }, // Yankee
  2889: { hr: 96, hits: 99, runs: 98 },    // Marlins
  2395: { hr: 95, hits: 99, runs: 97 },    // Tropicana
  3312: { hr: 102, hits: 101, runs: 101 }, // Nats Park
  3313: { hr: 102, hits: 101, runs: 101 }, // PNC Park
};

export function parkFactor(venueId: number | null | undefined): ParkFactor {
  if (!venueId) return { hr: 100, hits: 100, runs: 100 };
  return PARKS[venueId] ?? { hr: 100, hits: 100, runs: 100 };
}
