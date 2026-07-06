import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { getPlayer, type PlayerStatLine } from "@/lib/mlb.functions";
import { getMlbMovers, type HitterMover, type PitcherMover } from "@/lib/movers.functions";
import { getMlbPulse } from "@/lib/pulse.functions";
import { todayInAppTz } from "@/lib/timezone";

function playerQuery(playerId: number) {
  return queryOptions({
    queryKey: ["player", playerId],
    queryFn: () => getPlayer({ data: { playerId } }),
    staleTime: 10 * 60 * 1000,
  });
}
const moversQ = queryOptions({
  queryKey: ["movers", "player-hub"],
  queryFn: () => getMlbMovers({ data: { date: todayInAppTz() } }),
  staleTime: 5 * 60 * 1000,
});
function pulseQ(date: string) {
  return queryOptions({
    queryKey: ["pulse", "player-hub", date],
    queryFn: () => getMlbPulse({ data: { date } }),
    staleTime: 60_000,
  });
}

export const Route = createFileRoute("/_authenticated/player/$mlbId")({
  head: ({ params }) => ({
    meta: [
      { title: `Player ${params.mlbId} — Diamond` },
      { name: "description", content: "MLB player profile: season stats, career, and Diamond form context." },
      { property: "og:title", content: `Player — Diamond` },
      { property: "og:description", content: "Season stats, career history, and current Diamond form context." },
    ],
  }),
  loader: ({ context, params }) => {
    const id = Number(params.mlbId);
    if (!Number.isFinite(id) || id <= 0) throw notFound();
    return context.queryClient.ensureQueryData(playerQuery(id));
  },
  component: PlayerHub,
  errorComponent: ({ error }) => (
    <div className="p-6 text-sm text-[var(--warm-muted)]">Couldn't load player: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-6">Player not found.</div>,
});

function PlayerHub() {
  const { mlbId } = Route.useParams();
  const id = Number(mlbId);
  const { data: player } = useSuspenseQuery(playerQuery(id));
  const movers = useQuery(moversQ);
  const today = todayInAppTz();
  const pulse = useQuery(pulseQ(today));

  const isPitcher = player.group === "pitching";
  const moverHit = !isPitcher
    ? movers.data?.hitters.risers.concat(movers.data?.hitters.fallers ?? []).find((m: HitterMover) => m.mlbId === id)
    : null;
  const moverPit = isPitcher
    ? movers.data?.pitchers.risers.concat(movers.data?.pitchers.fallers ?? []).find((m: PitcherMover) => m.mlbId === id)
    : null;

  // Today's game context — find the player in today's Pulse
  const pulseHitter = pulse.data?.hitters.find((h) => h.mlbId === id) ?? null;
  const pulsePitcher = pulse.data?.pitchers.find((p) => p.mlbId === id) ?? null;
  const pulseGame = pulseHitter
    ? pulse.data?.games.find((g) => g.id === pulseHitter.gameId)
    : pulsePitcher
      ? pulse.data?.games.find((g) => g.id === pulsePitcher.gameId)
      : null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-10">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-4 border-b border-[var(--border)] pb-5">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--charcoal)_80%,transparent)] font-display text-2xl font-bold text-[var(--cream)]">
          {player.primaryNumber}
        </div>
        <div className="min-w-0 flex-1">
          <div className="eyebrow text-[var(--primary)]">Player Hub · {player.primaryPositionType}</div>
          <h1 className="mt-1 text-[28px] leading-tight text-[var(--cream)] md:text-[36px]">{player.fullName}</h1>
          <div className="mono mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
            {player.currentTeam ? <span>{player.currentTeam.name}</span> : null}
            <span>Pos {player.position}</span>
            <span>Bats {player.bats}</span>
            <span>Throws {player.throws}</span>
            {player.height ? <span>{player.height}</span> : null}
            {player.weight ? <span>{player.weight} lb</span> : null}
          </div>
        </div>
        <Link to="/explore" className="mono rounded-sm border border-[var(--border)] px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)] hover:text-[var(--cream)]">
          ← Explore
        </Link>
      </div>

      {/* Today's game context */}
      {pulseGame ? (
        <section className="mt-5 rounded-sm border border-[color-mix(in_oklab,var(--brass)_35%,var(--border))] bg-[color-mix(in_oklab,var(--charcoal)_82%,transparent)] px-4 py-3">
          <div className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--brass)]">Today’s Game</div>
          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <Link to="/game/$gamePk" params={{ gamePk: String(pulseGame.gamePk ?? "") }} className="text-lg font-semibold text-[var(--cream)] hover:text-[var(--brass)]">
                {pulseGame.away.abbreviation} @ {pulseGame.home.abbreviation}
              </Link>
              <div className="mono mt-0.5 text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
                {pulseGame.statusText}
                {pulseGame.status === "live" && pulseGame.inning ? ` · ${pulseGame.inningHalf} ${pulseGame.inning}` : null}
                {pulseGame.venue ? ` · ${pulseGame.venue}` : null}
              </div>
            </div>
            <div className="mono text-right text-[11px] text-[var(--parchment)]">
              {pulseHitter?.today ? `${pulseHitter.today.H}-${pulseHitter.today.AB}, ${pulseHitter.today.R} R, ${pulseHitter.today.RBI} RBI, ${pulseHitter.today.BB} BB, ${pulseHitter.today.K} K` : null}
              {pulsePitcher?.today ? `${pulsePitcher.today.inningsPitched ?? "0.0"} IP, ${pulsePitcher.today.H} H, ${pulsePitcher.today.ER} ER, ${pulsePitcher.today.BB} BB, ${pulsePitcher.today.K} K` : null}
              {!pulseHitter?.today && !pulsePitcher?.today ? <span className="text-[var(--warm-muted)]">Waiting for verified data</span> : null}
            </div>
          </div>
          {pulseHitter ? (
            <div className="mono mt-1 text-[10px] uppercase tracking-widest text-[var(--warm-muted)]">
              Lineup slot {pulseHitter.lineupSlot ?? "—"} · {pulseHitter.lineupState.label}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Diamond 14-day form context */}
      {moverHit || moverPit ? (
        <section className="mt-5 rounded-sm border border-[var(--border)] px-4 py-3">
          <div className="mono flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">
            <span>Diamond 14-day form</span>
            <span className="text-[var(--brass)]">{statusLabel((moverHit ?? moverPit)!.status)}</span>
          </div>
          {moverHit ? <HitterFormLine m={moverHit} /> : null}
          {moverPit ? <PitcherFormLine m={moverPit} /> : null}
          <div className="mono mt-2 text-[10px] text-[var(--warm-muted)]">
            {moverHit ? `Sample: ${moverHit.recent.games}G · ${moverHit.recent.pa} PA (last 14 days) vs season ${moverHit.season.games}G · ${moverHit.season.pa} PA` : null}
            {moverPit ? `Sample: ${moverPit.recent.games}G · ${moverPit.recent.starts} starts · ${moverPit.recent.ip.toFixed(1)} IP (last 14 days) vs season ${moverPit.season.games}G · ${moverPit.season.ip.toFixed(1)} IP` : null}
          </div>
          <p className="mt-1 text-[11px] text-[var(--parchment)]">{(moverHit ?? moverPit)!.reason}</p>
        </section>
      ) : movers.isLoading ? null : (
        <section className="mt-5 rounded-sm border border-dashed border-[var(--border)] px-4 py-3 text-[11px] text-[var(--warm-muted)]">
          No Diamond 14-day form signal for this player (sample below thresholds or outside the recent window).
        </section>
      )}

      {/* Season / Career */}
      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <StatCard title="Season" line={player.season} group={player.group} />
        <StatCard title="Career" line={player.career} group={player.group} />
      </section>

      {/* Year-by-year history */}
      {player.history.length ? (
        <section className="mt-6">
          <div className="mono mb-2 text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">Year by Year</div>
          <div className="overflow-x-auto rounded-sm border border-[var(--border)]">
            <table className="w-full text-xs">
              <thead className="bg-[color-mix(in_oklab,var(--charcoal)_90%,transparent)] text-[10px] uppercase tracking-[0.14em] text-[var(--warm-muted)]">
                {player.group === "hitting" ? (
                  <tr><th className="px-2 py-2 text-left">Season</th><th className="px-2">Team</th><th className="px-2 text-right">AVG</th><th className="px-2 text-right">OBP</th><th className="px-2 text-right">SLG</th><th className="px-2 text-right">OPS</th><th className="px-2 text-right">HR</th><th className="px-2 text-right">RBI</th><th className="px-2 text-right">R</th><th className="px-2 text-right">H</th></tr>
                ) : (
                  <tr><th className="px-2 py-2 text-left">Season</th><th className="px-2">Team</th><th className="px-2 text-right">ERA</th><th className="px-2 text-right">WHIP</th><th className="px-2 text-right">W-L</th><th className="px-2 text-right">SV</th><th className="px-2 text-right">SO</th><th className="px-2 text-right">IP</th></tr>
                )}
              </thead>
              <tbody>
                {player.history.map((h, i) => (
                  <tr key={i} className="border-t border-[var(--border)]">
                    {player.group === "hitting" ? (
                      <>
                        <td className="px-2 py-1.5">{h.season}</td><td className="px-2 text-[var(--warm-muted)]">{h.team}</td>
                        <td className="px-2 mono text-right">{h.avg ?? "—"}</td><td className="px-2 mono text-right">{h.obp ?? "—"}</td>
                        <td className="px-2 mono text-right">{h.slg ?? "—"}</td><td className="px-2 mono text-right">{h.ops ?? "—"}</td>
                        <td className="px-2 mono text-right">{h.hr ?? "—"}</td><td className="px-2 mono text-right">{h.rbi ?? "—"}</td>
                        <td className="px-2 mono text-right">{h.runs ?? "—"}</td><td className="px-2 mono text-right">{h.hits ?? "—"}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-2 py-1.5">{h.season}</td><td className="px-2 text-[var(--warm-muted)]">{h.team}</td>
                        <td className="px-2 mono text-right">{h.era ?? "—"}</td><td className="px-2 mono text-right">{h.whip ?? "—"}</td>
                        <td className="px-2 mono text-right">{h.w ?? 0}-{h.l ?? 0}</td>
                        <td className="px-2 mono text-right">{h.sv ?? "—"}</td><td className="px-2 mono text-right">{h.so ?? "—"}</td>
                        <td className="px-2 mono text-right">{h.ip ?? "—"}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function StatCard({ title, line, group }: { title: string; line: PlayerStatLine | null; group: "hitting" | "pitching" }) {
  if (!line) {
    return (
      <div className="rounded-sm border border-dashed border-[var(--border)] p-4 text-[11px] text-[var(--warm-muted)]">
        {title}: no official line available.
      </div>
    );
  }
  return (
    <div className="rounded-sm border border-[var(--border)] p-4">
      <div className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--warm-muted)]">{title} · {line.team || line.season}</div>
      {group === "hitting" ? (
        <div className="mt-2 grid grid-cols-4 gap-2 text-[13px] mono">
          <Stat label="AVG" v={line.avg} /><Stat label="OBP" v={line.obp} /><Stat label="SLG" v={line.slg} /><Stat label="OPS" v={line.ops} />
          <Stat label="HR" v={line.hr} /><Stat label="RBI" v={line.rbi} /><Stat label="R" v={line.runs} /><Stat label="H" v={line.hits} />
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-4 gap-2 text-[13px] mono">
          <Stat label="ERA" v={line.era} /><Stat label="WHIP" v={line.whip} /><Stat label="W-L" v={`${line.w ?? 0}-${line.l ?? 0}`} /><Stat label="SV" v={line.sv} />
          <Stat label="SO" v={line.so} /><Stat label="IP" v={line.ip} />
        </div>
      )}
    </div>
  );
}
function Stat({ label, v }: { label: string; v: string | number | undefined }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">{label}</div>
      <div className="text-[var(--cream)]">{v ?? "—"}</div>
    </div>
  );
}
function statusLabel(status: "riser" | "faller" | "early_sample"): string {
  return status === "riser" ? "Riser" : status === "faller" ? "Faller" : "Early Sample";
}
function HitterFormLine({ m }: { m: HitterMover }) {
  return (
    <div className="mt-2 grid grid-cols-4 gap-2 text-[12px] mono">
      <FormCell label="OPS" recent={m.recent.ops.toFixed(3).replace(/^0\./, ".")} season={m.season.ops.toFixed(3).replace(/^0\./, ".")} />
      <FormCell label="AVG" recent={m.recent.avg.toFixed(3).replace(/^0\./, ".")} season={m.season.avg.toFixed(3).replace(/^0\./, ".")} />
      <FormCell label="SLG" recent={m.recent.slg.toFixed(3).replace(/^0\./, ".")} season={m.season.slg.toFixed(3).replace(/^0\./, ".")} />
      <FormCell label="HR" recent={String(m.recent.hr)} season={String(m.season.hr)} />
    </div>
  );
}
function PitcherFormLine({ m }: { m: PitcherMover }) {
  return (
    <div className="mt-2 grid grid-cols-4 gap-2 text-[12px] mono">
      <FormCell label="ERA" recent={m.recent.era.toFixed(2)} season={m.season.era.toFixed(2)} />
      <FormCell label="WHIP" recent={m.recent.whip.toFixed(2)} season={m.season.whip.toFixed(2)} />
      <FormCell label="K" recent={String(m.recent.so)} season={String(m.season.so)} />
      <FormCell label="IP" recent={m.recent.ip.toFixed(1)} season={m.season.ip.toFixed(1)} />
    </div>
  );
}
function FormCell({ label, recent, season }: { label: string; recent: string; season: string }) {
  return (
    <div className="rounded-sm border border-[var(--border)] px-2 py-1">
      <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">{label}</div>
      <div className="text-[var(--cream)]">{recent} <span className="text-[10px] text-[var(--warm-muted)]">vs {season}</span></div>
    </div>
  );
}
