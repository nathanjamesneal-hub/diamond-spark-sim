import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getOdds } from "@/lib/odds.functions";

const oddsQuery = queryOptions({
  queryKey: ["odds"],
  queryFn: () => getOdds(),
  staleTime: 10 * 60 * 1000,
});

export const Route = createFileRoute("/odds")({
  head: () => ({
    meta: [
      { title: "Value board — Diamond" },
      { name: "description", content: "Live MLB odds from US sportsbooks. DraftKings, FanDuel, Fanatics, bet365, BetMGM, Caesars." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(oddsQuery),
  component: OddsPage,
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-xl p-8 text-sm">
      <div className="mono text-xs uppercase tracking-widest text-live">Odds API error</div>
      <p className="mt-2 text-muted-foreground">{error.message}</p>
    </div>
  ),
});

function OddsPage() {
  const { data } = useSuspenseQuery(oddsQuery);
  const [market, setMarket] = useState<"ML" | "TOTAL" | "RUNLINE">("ML");
  const [bookFilter, setBookFilter] = useState<string>("all");

  if (!data.configured) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-edge">Value board</div>
        <h1 className="mt-2 font-display text-3xl font-bold">Odds key missing</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Set <code className="mono text-edge">THE_ODDS_API_KEY</code> and reload to populate the board.
        </p>
      </div>
    );
  }

  const books = Array.from(new Set(data.rows.map((r) => r.book))).sort();
  const rows = data.rows
    .filter((r) => r.market === market)
    .filter((r) => bookFilter === "all" || r.book === bookFilter);

  // Group by event + selection, pick best price across books
  const grouped = new Map<string, typeof data.rows>();
  for (const r of rows) {
    const k = `${r.eventId}|${r.selection}|${r.line ?? ""}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(r);
  }

  const best = Array.from(grouped.entries()).map(([k, arr]) => {
    const sorted = [...arr].sort((a, b) => b.price - a.price); // best price = highest American
    const top = sorted[0];
    return {
      key: k, ...top,
      bookCount: arr.length,
      worstPrice: sorted[sorted.length - 1].price,
    };
  }).sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime());

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6">
      <div className="mono mb-1 text-[11px] uppercase tracking-[0.25em] text-edge">Value board</div>
      <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">Live MLB odds</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Best price across {books.length} US books · cached 10 min · {data.rows.length} lines
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {(["ML", "TOTAL", "RUNLINE"] as const).map((m) => (
          <button key={m} onClick={() => setMarket(m)}
            className={`mono rounded-md px-3 py-1.5 text-xs uppercase tracking-widest ${
              market === m ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}>
            {m}
          </button>
        ))}
        <select value={bookFilter} onChange={(e) => setBookFilter(e.target.value)}
          className="ml-auto rounded-md border border-input bg-background px-3 py-1.5 text-xs">
          <option value="all">All books</option>
          {books.map((b) => <option key={b}>{b}</option>)}
        </select>
      </div>

      <div className="mt-5 rounded-xl border border-border/60 bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Game</th>
                <th className="px-2">Selection</th>
                <th className="px-2 text-right">Best price</th>
                <th className="px-2">Book</th>
                <th className="px-2 text-right">Worst</th>
                <th className="px-2 text-right">Implied %</th>
                <th className="px-2 text-right">Start</th>
              </tr>
            </thead>
            <tbody>
              {best.map((r) => (
                <tr key={r.key} className="border-t border-border/40">
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.awayTeam} @ {r.homeTeam}
                  </td>
                  <td className="px-2">
                    {r.selection}{r.line !== null ? ` ${r.line > 0 ? "+" : ""}${r.line}` : ""}
                  </td>
                  <td className="px-2 text-right mono tabular-nums text-edge">
                    {r.price > 0 ? `+${r.price}` : r.price}
                  </td>
                  <td className="px-2">{r.book}</td>
                  <td className="px-2 text-right mono tabular-nums text-muted-foreground">
                    {r.worstPrice > 0 ? `+${r.worstPrice}` : r.worstPrice}
                  </td>
                  <td className="px-2 text-right mono tabular-nums">
                    {(r.impliedProb * 100).toFixed(1)}%
                  </td>
                  <td className="px-2 text-right mono tabular-nums text-muted-foreground">
                    {new Date(r.commenceTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </td>
                </tr>
              ))}
              {best.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No lines available.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Want to log one? Head to <Link to="/bets" className="text-primary hover:underline">your tracker</Link>.
        Model-vs-line edge ranking ships in the next iteration once today's sims are precomputed.
      </p>
    </div>
  );
}
