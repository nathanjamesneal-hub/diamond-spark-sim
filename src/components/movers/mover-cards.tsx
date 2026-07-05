import { Link } from "@tanstack/react-router";
import type { HitterMover, PitcherMover } from "@/lib/movers.functions";

function fmt3(n: number): string {
  return n.toFixed(3).replace(/^0\./, ".");
}

function trendColor(delta: number, positiveIsGood: boolean) {
  const good = positiveIsGood ? delta > 0 : delta < 0;
  const bad = positiveIsGood ? delta < 0 : delta > 0;
  if (good) return "text-emerald-400";
  if (bad) return "text-rose-400";
  return "text-muted-foreground";
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
    <div className="rounded border border-border/60 bg-black/30 px-2 py-1.5">
      <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="mono text-[15px] font-semibold text-foreground">{formatter(recent)}</span>
        <span className="mono text-[10px] text-muted-foreground">vs {formatter(season)}</span>
      </div>
      <div className={`mono text-[10px] ${trendColor(delta, positiveIsGood)}`}>
        {delta > 0 ? "+" : ""}
        {formatter(delta)}
      </div>
    </div>
  );
}

export function HitterCard({ m }: { m: HitterMover }) {
  const early = m.status === "early_sample";
  return (
    <Link
      to="/players/$playerId"
      params={{ playerId: String(m.mlbId) }}
      className="group block rounded-lg border border-border/70 bg-gradient-to-b from-[#0d1220] to-[#080b14] p-3 shadow-[0_1px_0_rgb(255_255_255/0.03)_inset] transition-colors hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{m.name}</div>
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {m.team ?? "—"} · {m.position ?? "H"}
          </div>
        </div>
        <span
          className={`mono rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest ${
            m.status === "riser"
              ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : m.status === "faller"
                ? "border border-rose-500/40 bg-rose-500/10 text-rose-300"
                : "border border-border/60 bg-black/40 text-muted-foreground"
          }`}
        >
          {m.status === "early_sample" ? "Early" : m.status}
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

      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="mono">
          Recent: {m.recent.games}G / {m.recent.pa} PA
        </span>
        <span className="mono">Season: {m.season.games}G / {m.season.pa} PA</span>
      </div>

      <p className={`mt-2 text-[11px] leading-snug ${early ? "text-muted-foreground" : "text-foreground/85"}`}>
        {m.reason}
      </p>
    </Link>
  );
}

function MiniStat({ label, season, recent }: { label: string; season: number; recent: number }) {
  return (
    <div className="rounded border border-border/40 bg-black/20 px-1.5 py-1 text-center">
      <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mono text-[12px] font-semibold text-foreground">{recent}</div>
      <div className="mono text-[9px] text-muted-foreground">·{season}</div>
    </div>
  );
}

export function PitcherCard({ m }: { m: PitcherMover }) {
  return (
    <Link
      to="/players/$playerId"
      params={{ playerId: String(m.mlbId) }}
      className="group block rounded-lg border border-border/70 bg-gradient-to-b from-[#0d1220] to-[#080b14] p-3 shadow-[0_1px_0_rgb(255_255_255/0.03)_inset] transition-colors hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{m.name}</div>
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {m.team ?? "—"} · P
          </div>
        </div>
        <span
          className={`mono rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest ${
            m.status === "riser"
              ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : m.status === "faller"
                ? "border border-rose-500/40 bg-rose-500/10 text-rose-300"
                : "border border-border/60 bg-black/40 text-muted-foreground"
          }`}
        >
          {m.status === "early_sample" ? "Early" : m.status}
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
        <div className="rounded border border-border/60 bg-black/30 px-2 py-1.5">
          <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">K/9</div>
          <div className="mt-0.5 mono text-[15px] font-semibold text-foreground">
            {m.recent.ip > 0 ? ((m.recent.so * 9) / m.recent.ip).toFixed(1) : "—"}
          </div>
          <div className="mono text-[10px] text-muted-foreground">
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

      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="mono">
          Recent: {m.recent.starts}GS / {m.recent.ip.toFixed(1)} IP
        </span>
        <span className="mono">
          Season: {m.season.starts}GS / {m.season.ip.toFixed(1)} IP
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-foreground/85">{m.reason}</p>
    </Link>
  );
}
