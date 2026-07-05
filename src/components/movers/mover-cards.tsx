import { Link } from "@tanstack/react-router";
import type { HitterMover, PitcherMover } from "@/lib/movers.functions";

function fmt3(n: number): string {
  return n.toFixed(3).replace(/^0\./, ".");
}

function trendClass(delta: number, positiveIsGood: boolean) {
  const good = positiveIsGood ? delta > 0 : delta < 0;
  const bad = positiveIsGood ? delta < 0 : delta > 0;
  if (good) return "text-[var(--field)]";
  if (bad) return "text-[var(--cardinal)]";
  return "text-[#7a725f]";
}

function StatBlock({
  label,
  season,
  recent,
  formatter = (v) => v.toFixed(2),
  positiveIsGood = true,
}: {
  label: string;
  season: number;
  recent: number;
  formatter?: (v: number) => string;
  positiveIsGood?: boolean;
}) {
  const delta = recent - season;
  return (
    <div className="rounded-sm border border-[var(--border)] bg-[color-mix(in_oklab,var(--ink)_55%,var(--card))] px-2 py-1.5">
      <div className="mono text-[9px] uppercase tracking-[0.18em] text-[var(--warm-muted)]">{label}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="mono text-[15px] font-bold text-[var(--cream)]">{formatter(recent)}</span>
        <span className="mono text-[10px] text-[var(--warm-muted)]">vs {formatter(season)}</span>
      </div>
      <div className={`mono text-[10px] font-semibold ${trendClass(delta, positiveIsGood)}`}>
        {delta > 0 ? "+" : ""}
        {formatter(delta)}
      </div>
    </div>
  );
}

function statusChip(status: HitterMover["status"] | PitcherMover["status"]) {
  if (status === "riser")
    return "bg-[color-mix(in_oklab,var(--field)_22%,transparent)] text-[var(--field)] border border-[color-mix(in_oklab,var(--field)_55%,transparent)] shadow-[0_0_10px_color-mix(in_oklab,var(--field)_35%,transparent)]";
  if (status === "faller")
    return "bg-[color-mix(in_oklab,var(--cardinal)_22%,transparent)] text-[var(--cardinal)] border border-[color-mix(in_oklab,var(--cardinal)_55%,transparent)] shadow-[0_0_10px_color-mix(in_oklab,var(--cardinal)_35%,transparent)]";
  return "bg-[var(--muted)] text-[var(--warm-muted)] border border-[var(--border)]";
}

function statusLabel(status: HitterMover["status"] | PitcherMover["status"]) {
  if (status === "riser") return "Riser";
  if (status === "faller") return "Faller";
  return "Early Sample";
}

function edgeClass(status: HitterMover["status"] | PitcherMover["status"]) {
  if (status === "riser") return "riser-edge";
  if (status === "faller") return "faller-edge";
  return "";
}

export function HitterCard({ m }: { m: HitterMover }) {
  const early = m.status === "early_sample";
  return (
    <Link
      to="/players/$playerId"
      params={{ playerId: String(m.mlbId) }}
      className={`scouting-card group block overflow-hidden p-3 transition-transform hover:-translate-y-[1px] ${edgeClass(m.status)}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-bold leading-tight tracking-tight text-[var(--cream)]">
            {m.name}
          </div>
          <div className="mono mt-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--warm-muted)]">
            {m.team ?? "—"} · {m.position ?? "H"}
          </div>
        </div>
        <span className={`mono rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.15em] ${statusChip(m.status)}`}>
          {statusLabel(m.status)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <StatBlock label="OPS" season={m.season.ops} recent={m.recent.ops} formatter={fmt3} />
        <StatBlock label="AVG" season={m.season.avg} recent={m.recent.avg} formatter={fmt3} />
        <StatBlock label="SLG" season={m.season.slg} recent={m.recent.slg} formatter={fmt3} />
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1.5">
        <MiniStat label="HR" season={m.season.hr} recent={m.recent.hr} />
        <MiniStat label="H" season={m.season.hits} recent={m.recent.hits} />
        <MiniStat label="R" season={m.season.runs} recent={m.recent.runs} />
        <MiniStat label="RBI" season={m.season.rbi} recent={m.recent.rbi} />
      </div>

      <div className="mono mt-2 flex items-center justify-between border-t border-[var(--border)] pt-1.5 text-[10px] text-[var(--warm-muted)]">
        <span>Recent {m.recent.games}G · {m.recent.pa} PA</span>
        <span>Season {m.season.games}G · {m.season.pa} PA</span>
      </div>

      <p className={`mt-1.5 text-[11px] leading-snug ${early ? "text-[var(--warm-muted)]" : "text-[var(--parchment)]"}`}>
        {m.reason}
      </p>
    </Link>
  );
}

function MiniStat({ label, season, recent }: { label: string; season: number; recent: number }) {
  return (
    <div className="rounded-sm border border-[var(--border)] bg-[color-mix(in_oklab,var(--ink)_45%,var(--card))] px-1.5 py-1 text-center">
      <div className="mono text-[9px] uppercase tracking-[0.16em] text-[var(--warm-muted)]">{label}</div>
      <div className="mono text-[12px] font-bold text-[var(--cream)]">{recent}</div>
      <div className="mono text-[9px] text-[var(--warm-muted)]">·{season}</div>
    </div>
  );
}

export function PitcherCard({ m }: { m: PitcherMover }) {
  return (
    <Link
      to="/players/$playerId"
      params={{ playerId: String(m.mlbId) }}
      className={`scouting-card group block overflow-hidden p-3 transition-transform hover:-translate-y-[1px] ${edgeClass(m.status)}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-bold leading-tight tracking-tight text-[var(--cream)]">
            {m.name}
          </div>
          <div className="mono mt-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--warm-muted)]">
            {m.team ?? "—"} · P
          </div>
        </div>
        <span className={`mono rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.15em] ${statusChip(m.status)}`}>
          {statusLabel(m.status)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <StatBlock
          label="ERA"
          season={m.season.era}
          recent={m.recent.era}
          formatter={(v) => v.toFixed(2)}
          positiveIsGood={false}
        />
        <StatBlock
          label="WHIP"
          season={m.season.whip}
          recent={m.recent.whip}
          formatter={(v) => v.toFixed(2)}
          positiveIsGood={false}
        />
        <div className="rounded-sm border border-[var(--border)] bg-[color-mix(in_oklab,var(--ink)_55%,var(--card))] px-2 py-1.5">
          <div className="mono text-[9px] uppercase tracking-[0.18em] text-[var(--warm-muted)]">K/9</div>
          <div className="mono mt-0.5 text-[15px] font-bold text-[var(--cream)]">
            {m.recent.ip > 0 ? ((m.recent.so * 9) / m.recent.ip).toFixed(1) : "—"}
          </div>
          <div className="mono text-[10px] text-[var(--warm-muted)]">
            vs {m.season.ip > 0 ? ((m.season.so * 9) / m.season.ip).toFixed(1) : "—"}
          </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1.5">
        <MiniStat label="IP" season={Math.round(m.season.ip)} recent={Math.round(m.recent.ip)} />
        <MiniStat label="K" season={m.season.so} recent={m.recent.so} />
        <MiniStat label="BB" season={m.season.bb} recent={m.recent.bb} />
        <MiniStat label="HR" season={m.season.hr} recent={m.recent.hr} />
      </div>

      <div className="mono mt-2 flex items-center justify-between border-t border-[var(--border)] pt-1.5 text-[10px] text-[var(--warm-muted)]">
        <span>Recent {m.recent.starts}GS · {m.recent.ip.toFixed(1)} IP</span>
        <span>Season {m.season.starts}GS · {m.season.ip.toFixed(1)} IP</span>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-[var(--parchment)]">{m.reason}</p>
    </Link>
  );
}
