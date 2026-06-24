import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { simulateGame } from "@/lib/sim.functions";
import { formatDateTimeInAppTz } from "@/lib/timezone";


const simQuery = (gamePk: number) =>
  queryOptions({
    queryKey: ["sim", gamePk],
    queryFn: () => simulateGame({ data: { gamePk } }),
    staleTime: 10 * 60 * 1000,
  });

export const Route = createFileRoute("/matchups/$gamePk")({
  head: ({ params }) => ({
    meta: [
      { title: `Matchup ${params.gamePk} — Diamond` },
      { name: "description", content: "Monte Carlo projection: win probability, run distribution, and player prop edges." },
      { property: "og:title", content: `Matchup projection — Diamond` },
      { property: "og:description", content: "Win prob, projected score, prop edges from 2,000 simulations." },
    ],
  }),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(simQuery(Number(params.gamePk))),
  component: MatchupPage,
  errorComponent: ({ error, reset }) => (
    <div className="mx-auto max-w-2xl p-8 text-sm">
      <div className="mono text-xs uppercase tracking-widest text-live">Sim error</div>
      <p className="mt-2 text-muted-foreground">{error.message}</p>
      <button onClick={reset} className="mt-4 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
        Retry
      </button>
    </div>
  ),
  notFoundComponent: () => <div className="p-8">Game not found.</div>,
});

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}
function american(v: number) {
  return v > 0 ? `+${v}` : `${v}`;
}

function MatchupPage() {
  const { gamePk } = Route.useParams();
  const { data } = useSuspenseQuery(simQuery(Number(gamePk)));
  const { meta, result } = data;

  const totalChartData = result.totalDist.map((d) => ({
    runs: d.runs,
    pct: +(d.pct * 100).toFixed(2),
  }));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6 md:py-10">
      {/* Header */}
      <div className="mb-6">
        <Link to="/" className="mono text-[11px] uppercase tracking-[0.25em] text-edge hover:underline">
          ← Today
        </Link>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight md:text-4xl">
          {meta.awayAbbrev} @ {meta.homeAbbrev}
        </h1>
        <div className="mt-1 text-sm text-muted-foreground">
          {meta.venue} · {formatDateTimeInAppTz(meta.date)} CT · {result.iterations.toLocaleString()} sims
        </div>
        {meta.warnings.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {meta.warnings.map((w) => (
              <span key={w} className="mono rounded-full bg-secondary/40 px-2 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
                {w}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Win prob + fair lines */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-border/60 bg-card p-5 md:col-span-2">
          <div className="mono mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">
            Diamond win probability
          </div>
          <div className="flex h-3 overflow-hidden rounded-full bg-secondary/40">
            <div className="bg-edge" style={{ width: `${result.awayWinProb * 100}%` }} />
            <div className="bg-primary" style={{ width: `${result.homeWinProb * 100}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-sm">
            <span><span className="mono text-edge">{meta.awayAbbrev}</span> {pct(result.awayWinProb)}</span>
            <span>{pct(result.homeWinProb)} <span className="mono text-primary">{meta.homeAbbrev}</span></span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <Stat label="Fair ML (away)" value={american(result.fairAwayML)} />
            <Stat label="Fair ML (home)" value={american(result.fairHomeML)} />
            <Stat label="Fair total" value={result.fairTotal.toFixed(1)} />
          </div>
        </div>
        <div className="rounded-xl border border-border/60 bg-card p-5">
          <div className="mono mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">
            Projected score
          </div>
          <div className="flex items-baseline justify-between">
            <div>
              <div className="mono text-xs text-edge">{meta.awayAbbrev}</div>
              <div className="font-display text-4xl font-bold tabular-nums">{result.meanAwayRuns.toFixed(1)}</div>
            </div>
            <div className="text-2xl text-muted-foreground">–</div>
            <div className="text-right">
              <div className="mono text-xs text-primary">{meta.homeAbbrev}</div>
              <div className="font-display text-4xl font-bold tabular-nums">{result.meanHomeRuns.toFixed(1)}</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
            <div className="rounded-md bg-secondary/40 p-2">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">NRFI</div>
              <div className="mono mt-1 tabular-nums">{pct(result.nrfi)}</div>
            </div>
            <div className="rounded-md bg-secondary/40 p-2">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">YRFI</div>
              <div className="mono mt-1 tabular-nums">{pct(result.yrfi)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Run total distribution */}
      <div className="mt-6 rounded-xl border border-border/60 bg-card p-5">
        <div className="mono mb-3 text-[10px] uppercase tracking-widest text-muted-foreground">
          Total runs distribution
        </div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={totalChartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="totalGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(0.78 0.14 195)" stopOpacity={0.6} />
                  <stop offset="100%" stopColor="oklch(0.78 0.14 195)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="runs" stroke="currentColor" tick={{ fontSize: 11 }} />
              <YAxis stroke="currentColor" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
              <Tooltip
                contentStyle={{ background: "oklch(0.23 0.028 250)", border: "1px solid oklch(0.32 0.025 250)", borderRadius: 8 }}
                formatter={(v: any) => [`${v}%`, "Probability"]}
                labelFormatter={(l) => `${l} runs`}
              />
              <ReferenceLine x={Math.round(result.meanTotal)} stroke="oklch(0.68 0.17 240)" strokeDasharray="3 3" />
              <Area type="monotone" dataKey="pct" stroke="oklch(0.78 0.14 195)" fill="url(#totalGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Pitcher projections */}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <PitcherCard
          team={meta.awayAbbrev}
          name={meta.awayStarter}
          dist={result.awayPitcher}
        />
        <PitcherCard
          team={meta.homeAbbrev}
          name={meta.homeStarter}
          dist={result.homePitcher}
        />
      </div>

      {/* Lineup tables */}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <LineupCard title={`${meta.awayAbbrev} batters`} accent="text-edge" batters={result.awayBatters} />
        <LineupCard title={`${meta.homeAbbrev} batters`} accent="text-primary" batters={result.homeBatters} />
      </div>

      {/* Prop board */}
      <div className="mt-6 rounded-xl border border-border/60 bg-card p-5">
        <div className="mono mb-3 text-[10px] uppercase tracking-widest text-edge">
          Player prop probabilities (model)
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Hook into a sportsbook line (Phase 2.5) to see edge %. For now, these are pure model probabilities.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="py-2 pr-2">Player</th>
                <th className="px-2">Market</th>
                <th className="px-2 text-right">Model %</th>
                <th className="px-2 text-right">Mean</th>
              </tr>
            </thead>
            <tbody>
              {[...result.awayBatters, ...result.homeBatters].flatMap((b) => [
                { name: b.name, market: "H 0.5", prob: b.H.probAtLeast1, mean: b.H.mean },
                { name: b.name, market: "H 1.5", prob: b.H.probAtLeast2, mean: b.H.mean },
                { name: b.name, market: "HR 0.5", prob: b.HR.probAtLeast1, mean: b.HR.mean },
                { name: b.name, market: "TB 1.5", prob: b.TB.probAtLeast2, mean: b.TB.mean },
              ]).filter((r) => r.prob > 0.15 && r.prob < 0.92).sort((a, b) => b.prob - a.prob).slice(0, 20)
                .map((r, i) => (
                  <tr key={i} className="border-t border-border/40">
                    <td className="py-2 pr-2">{r.name}</td>
                    <td className="px-2 text-muted-foreground">{r.market}</td>
                    <td className="px-2 text-right mono tabular-nums">{pct(r.prob)}</td>
                    <td className="px-2 text-right mono tabular-nums text-muted-foreground">{r.mean.toFixed(2)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mono mt-1 text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}

function PitcherCard({ team, name, dist }: { team: string; name: string; dist: any }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-5">
      <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{team} starter</div>
      <div className="mt-1 font-display text-xl font-semibold">{name}</div>
      <div className="mt-4 grid grid-cols-4 gap-3 text-center">
        <MiniStat label="IP" v={(dist.outs.mean / 3).toFixed(1)} />
        <MiniStat label="K" v={dist.K.mean.toFixed(1)} />
        <MiniStat label="BB" v={dist.BB.mean.toFixed(1)} />
        <MiniStat label="ER" v={dist.ER.mean.toFixed(1)} />
      </div>
      <div className="mt-3 text-[11px] text-muted-foreground mono">
        K range (p10–p90): {dist.K.p10.toFixed(0)} – {dist.K.p90.toFixed(0)}
      </div>
    </div>
  );
}

function MiniStat({ label, v }: { label: string; v: string }) {
  return (
    <div>
      <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mono mt-0.5 text-base font-bold tabular-nums">{v}</div>
    </div>
  );
}

function LineupCard({ title, accent, batters }: { title: string; accent: string; batters: any[] }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-5">
      <div className={`mono mb-3 text-[10px] uppercase tracking-widest ${accent}`}>{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-1">#</th>
              <th className="pr-2">Batter</th>
              <th className="px-1 text-right">H</th>
              <th className="px-1 text-right">HR</th>
              <th className="px-1 text-right">RBI</th>
              <th className="px-1 text-right">R</th>
              <th className="px-1 text-right">K</th>
              <th className="pl-1 text-right">BB</th>
            </tr>
          </thead>
          <tbody>
            {batters.map((b, i) => (
              <tr key={b.playerId} className="border-t border-border/40">
                <td className="py-1.5 pr-1 mono tabular-nums text-muted-foreground">{i + 1}</td>
                <td className="pr-2">{b.name}</td>
                <td className="px-1 text-right mono tabular-nums">{b.H.mean.toFixed(2)}</td>
                <td className="px-1 text-right mono tabular-nums">{b.HR.mean.toFixed(2)}</td>
                <td className="px-1 text-right mono tabular-nums">{b.RBI.mean.toFixed(2)}</td>
                <td className="px-1 text-right mono tabular-nums">{b.R.mean.toFixed(2)}</td>
                <td className="px-1 text-right mono tabular-nums text-muted-foreground">{b.K.mean.toFixed(2)}</td>
                <td className="pl-1 text-right mono tabular-nums text-muted-foreground">{b.BB.mean.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
