import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listBets, insertBet, settleBet, deleteBet } from "@/lib/bets.functions";

export const Route = createFileRoute("/_authenticated/bets")({
  head: () => ({
    meta: [
      { title: "Bet tracker — Diamond" },
      { name: "description", content: "Log every wager. Track ROI, units, and CLV." },
    ],
  }),
  component: BetsPage,
});

function BetsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listBets);
  const insert = useServerFn(insertBet);
  const settle = useServerFn(settleBet);
  const del = useServerFn(deleteBet);

  const { data: bets = [], isLoading } = useQuery({
    queryKey: ["bets"],
    queryFn: () => list(),
  });

  const addMut = useMutation({
    mutationFn: (vars: any) => insert({ data: vars }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bets"] }),
  });
  const settleMut = useMutation({
    mutationFn: (vars: any) => settle({ data: vars }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bets"] }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bets"] }),
  });

  // KPI math
  const settled = bets.filter((b: any) => b.status !== "open");
  const totalStake = settled.reduce((a: number, b: any) => a + Number(b.stake), 0);
  const totalPayout = settled.reduce((a: number, b: any) => a + Number(b.payout ?? 0), 0);
  const profit = totalPayout - totalStake;
  const roi = totalStake > 0 ? (profit / totalStake) * 100 : 0;
  const units = bets.reduce((a: number, b: any) => {
    if (b.status === "open") return a;
    const u = Number(b.stake) / 10; // 1u = $10 default
    if (b.status === "won") return a + u * impliedReturn(b.odds);
    if (b.status === "lost") return a - u;
    return a;
  }, 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <div className="mono mb-1 text-[11px] uppercase tracking-[0.25em] text-edge">Tracker</div>
      <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">Your bets</h1>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Kpi label="Units" value={units.toFixed(2)} positive={units > 0} />
        <Kpi label="Profit" value={`$${profit.toFixed(2)}`} positive={profit > 0} />
        <Kpi label="ROI" value={`${roi.toFixed(1)}%`} positive={roi > 0} />
      </div>

      <AddBetForm onSubmit={(v) => addMut.mutate(v)} pending={addMut.isPending} />

      <div className="mt-6 rounded-xl border border-border/60 bg-card">
        <div className="border-b border-border/60 px-4 py-3">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Log · {bets.length} bets
          </div>
        </div>
        {isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : bets.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No bets yet. Add your first above.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-2">Book</th>
                  <th className="px-2">Market</th>
                  <th className="px-2">Selection</th>
                  <th className="px-2 text-right">Odds</th>
                  <th className="px-2 text-right">Stake</th>
                  <th className="px-2">Status</th>
                  <th className="px-2 text-right">Payout</th>
                  <th className="px-2 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {bets.map((b: any) => (
                  <tr key={b.id} className="border-t border-border/40">
                    <td className="px-3 py-2 mono tabular-nums text-muted-foreground">
                      {new Date(b.placed_at).toLocaleDateString()}
                    </td>
                    <td className="px-2">{b.book ?? "—"}</td>
                    <td className="px-2 text-muted-foreground">{b.market}</td>
                    <td className="px-2">
                      {b.selection}
                      {b.line !== null && b.line !== undefined ? ` ${b.line}` : ""}
                    </td>
                    <td className="px-2 text-right mono tabular-nums">
                      {b.odds > 0 ? `+${b.odds}` : b.odds}
                    </td>
                    <td className="px-2 text-right mono tabular-nums">${Number(b.stake).toFixed(2)}</td>
                    <td className="px-2">
                      <StatusPill status={b.status} />
                    </td>
                    <td className="px-2 text-right mono tabular-nums">
                      {b.payout != null ? `$${Number(b.payout).toFixed(2)}` : "—"}
                    </td>
                    <td className="px-2 text-right whitespace-nowrap">
                      {b.status === "open" ? (
                        <>
                          <button onClick={() => settleMut.mutate({ id: b.id, status: "won" })}
                            className="rounded bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-accent">W</button>
                          <button onClick={() => settleMut.mutate({ id: b.id, status: "lost" })}
                            className="ml-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-accent">L</button>
                          <button onClick={() => settleMut.mutate({ id: b.id, status: "push" })}
                            className="ml-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-accent">P</button>
                        </>
                      ) : null}
                      <button onClick={() => delMut.mutate(b.id)}
                        className="ml-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-live">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function impliedReturn(odds: number) {
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

function Kpi({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card p-4 text-center">
      <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`mono mt-1 font-display text-2xl font-bold tabular-nums ${positive ? "text-edge" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: "bg-secondary text-foreground",
    won: "bg-edge/20 text-edge",
    lost: "bg-live/20 text-live",
    push: "bg-muted text-muted-foreground",
    void: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`mono rounded px-1.5 py-0.5 text-[9px] uppercase tracking-widest ${map[status]}`}>
      {status}
    </span>
  );
}

function AddBetForm({ onSubmit, pending }: { onSubmit: (v: any) => void; pending: boolean }) {
  const [market, setMarket] = useState("ML");
  const [selection, setSelection] = useState("");
  const [line, setLine] = useState("");
  const [odds, setOdds] = useState("-110");
  const [stake, setStake] = useState("10");
  const [book, setBook] = useState("DraftKings");
  const [gameLabel, setGameLabel] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({
      market, selection,
      line: line ? Number(line) : null,
      odds: Number(odds),
      stake: Number(stake),
      book, gameLabel: gameLabel || null,
    });
    setSelection(""); setLine(""); setGameLabel("");
  }

  return (
    <form onSubmit={submit} className="mt-6 rounded-xl border border-border/60 bg-card p-4">
      <div className="mono mb-3 text-[10px] uppercase tracking-widest text-edge">Log a bet</div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-7">
        <select value={market} onChange={(e) => setMarket(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs">
          <option>ML</option><option>TOTAL</option><option>RUNLINE</option>
          <option>HR</option><option>H</option><option>K</option><option>TB</option>
        </select>
        <input value={selection} onChange={(e) => setSelection(e.target.value)} required placeholder="Selection"
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs md:col-span-2" />
        <input value={line} onChange={(e) => setLine(e.target.value)} placeholder="Line"
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs" />
        <input value={odds} onChange={(e) => setOdds(e.target.value)} required placeholder="Odds"
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs" />
        <input value={stake} onChange={(e) => setStake(e.target.value)} required placeholder="Stake"
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs" />
        <select value={book} onChange={(e) => setBook(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs">
          <option>DraftKings</option><option>FanDuel</option><option>Fanatics</option>
          <option>BetMGM</option><option>bet365</option><option>Caesars</option><option>Other</option>
        </select>
      </div>
      <div className="mt-2 flex gap-2">
        <input value={gameLabel} onChange={(e) => setGameLabel(e.target.value)} placeholder="Optional: BOS @ NYY"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs" />
        <button type="submit" disabled={pending}
          className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
          {pending ? "…" : "Add bet"}
        </button>
      </div>
    </form>
  );
}
