/**
 * ForecastRow — one dense row in the Forecast Board.
 *
 * Desktop ≥sm: 11-column grid; right-aligned tabular numbers.
 * Mobile <sm: 2-line stacked layout.
 *
 * Color rules: faint left rail only for Live (live), Final beat/missed,
 * and the top-rank row. No per-number badges.
 */
import { Link } from "@tanstack/react-router";
import type {
  DiamondHitterCard,
  DiamondPitcherCard,
  ForecastBoardStatus,
} from "@/lib/projections.functions";
import { formatTimeInAppTz } from "@/lib/timezone";
import {
  formatActual,
  hitterMean,
  hitterProb,
  isPitcherMarket,
  pitcherMean,
  pitcherProb,
  type Market,
} from "./market";

export type BoardCard =
  | { kind: "hitter"; row: DiamondHitterCard }
  | { kind: "pitcher"; row: DiamondPitcherCard };

type Props = {
  card: BoardCard;
  rank: number; // 1-based within current market
  market: Market;
  onOpen: () => void;
};

function pct(p: number | null | undefined): string {
  if (p == null || !isFinite(p)) return "—";
  const v = p <= 1 ? p * 100 : p;
  return `${Math.round(v)}%`;
}
function num(n: number | null | undefined, digits = 2): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(digits);
}

function statusPill(s: ForecastBoardStatus): { label: string; cls: string; title?: string } {
  switch (s) {
    case "no_official": return { label: "Awaiting", cls: "text-muted-foreground/80" };
    case "preview":     return { label: "Preview",  cls: "text-amber-500", title: "Projected lineups — not an official Diamond forecast" };
    case "published":   return { label: "Published", cls: "text-muted-foreground" };
    case "locked":      return { label: "Locked",   cls: "text-foreground/80" };
    case "live":        return { label: "Live",     cls: "text-live" };
    case "final":       return { label: "Final",    cls: "text-foreground" };
  }
}

function railClass(s: ForecastBoardStatus, beatProjection: boolean | null, isTopRank: boolean): string {
  if (s === "live") return "before:bg-live";
  if (s === "final" && beatProjection === true) return "before:bg-[var(--color-success,#22c55e)]";
  if (s === "final" && beatProjection === false) return "before:bg-[var(--color-edge,#f97316)]/70";
  if (isTopRank) return "before:bg-amber-400";
  return "before:bg-transparent";
}

export function ForecastRow({ card, rank, market, onOpen }: Props) {
  const isHitter = card.kind === "hitter";
  const row = card.row as any;
  const prob = isHitter ? hitterProb(row, market) : pitcherProb(row, market);
  const mean = isHitter ? hitterMean(row, market) : pitcherMean(row, market);
  const status = row.forecast_status as ForecastBoardStatus;
  const pill = statusPill(status);
  const actualStr = formatActual(row.actual, market);

  // Determine beat/miss for the rail when final
  let beat: boolean | null = null;
  if (status === "final" && row.actual && mean != null) {
    let actualValue: number | null = null;
    switch (market) {
      case "hit": actualValue = row.actual.hits; break;
      case "hr":  actualValue = row.actual.home_runs; break;
      case "tb":  actualValue = row.actual.total_bases; break;
      case "rbi": actualValue = row.actual.rbis; break;
      case "pitcher_k": actualValue = row.actual.strikeouts; break;
      case "pitcher_bb": actualValue = row.actual.walks; break;
    }
    if (actualValue != null) beat = actualValue >= mean;
  }

  const railCls = railClass(status, beat, rank === 1);
  const playerId = row.mlb_id != null ? String(row.mlb_id) : null;

  // Mean cell — pct% for binary markets, decimal for count markets
  const meanCell = (() => {
    if (market === "pitcher_win" || market === "pitcher_qs") return "—";
    if (market === "pitcher_outs") return num(mean, 1);
    if (market === "pitcher_k" || market === "pitcher_bb") return num(mean, 1);
    return num(mean, 2);
  })();

  // Game cell content (Opp / first-pitch / live / final)
  const gameCell = (() => {
    if (status === "live") return <span className="text-live">Live</span>;
    if (status === "final") return <span>Final</span>;
    return (
      <>
        <span className="text-foreground/80">@ {row.opp_abbrev || "—"}</span>
        {row.first_pitch_at ? <span className="ml-1 text-muted-foreground">· {formatTimeInAppTz(row.first_pitch_at)}</span> : null}
      </>
    );
  })();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={`group relative cursor-pointer rounded-md border border-border/60 bg-card/60 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-card focus:outline-none focus:ring-1 focus:ring-primary/40 before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-r ${railCls}`}
    >
      {/* Desktop grid: Player | Game | #BO | Prob | Mean | PA | Diamond | Status | Actual */}
      <div className="hidden sm:grid sm:items-center sm:gap-2 sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_42px_56px_56px_42px_64px_72px_minmax(0,1.1fr)] text-xs">
        {/* Player + team */}
        <div className="min-w-0 truncate">
          {playerId ? (
            <Link
              to="/players/$playerId" params={{ playerId }}
              onClick={(e) => e.stopPropagation()}
              className="font-display text-sm font-semibold text-foreground hover:text-primary"
            >{row.player_name}</Link>
          ) : (
            <span className="font-display text-sm font-semibold text-foreground">{row.player_name}</span>
          )}
          <span className="mono ml-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">{row.team_abbrev}</span>
        </div>
        {/* Game cell */}
        <div className="mono min-w-0 truncate text-[11px] uppercase tracking-wider text-muted-foreground">{gameCell}</div>
        {/* Batting order */}
        <div className="mono text-center text-[11px] tabular-nums text-foreground/80">
          {isHitter && row.batting_order ? `#${row.batting_order}` : "—"}
        </div>
        {/* Probability */}
        <div className="mono text-right text-sm font-semibold tabular-nums text-primary">{pct(prob)}</div>
        {/* Mean */}
        <div className="mono text-right text-sm tabular-nums text-foreground">{meanCell}</div>
        {/* PA / BF */}
        <div className="mono text-right text-[11px] tabular-nums text-muted-foreground">
          {isHitter ? (row.projected_pa != null ? num(row.projected_pa, 1) : "—") : (row.projected_bf != null ? num(row.projected_bf, 0) : "—")}
        </div>
        {/* Diamond Score + rank */}
        <div className="mono text-right text-sm tabular-nums text-foreground">
          {row.diamond_score != null ? Math.round(row.diamond_score) : "—"}
          {rank <= 10 ? <span className="ml-1 text-[9px] uppercase tracking-widest text-muted-foreground">#{rank}</span> : null}
        </div>
        {/* Status */}
        <div title={pill.title} className={`mono text-right text-[10px] font-semibold uppercase tracking-widest ${pill.cls}`}>{pill.label}</div>
        {/* Actual */}
        <div className="mono min-w-0 truncate text-right text-[11px] tabular-nums text-foreground/90">{actualStr || ""}</div>
      </div>

      {/* Mobile stacked layout */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-1 sm:hidden">
        <div className="min-w-0 truncate">
          <span className="font-display text-sm font-semibold text-foreground">{row.player_name}</span>
          <span className="mono ml-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            {row.team_abbrev}{status === "live" ? " · LIVE" : status === "final" ? " · FINAL" : ` @ ${row.opp_abbrev || "—"}`}
            {isHitter && row.batting_order ? ` · #${row.batting_order}` : ""}
          </span>
        </div>
        <span className={`mono text-[10px] font-semibold uppercase tracking-widest ${pill.cls}`}>{pill.label}</span>

        <div className="mono col-span-2 mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
          <span><span className="text-muted-foreground">{(market === "pitcher_win" || market === "pitcher_qs") ? "" : "Prob "}</span><span className="font-semibold text-primary">{pct(prob)}</span></span>
          {meanCell !== "—" ? <span><span className="text-muted-foreground">Mean </span><span className="text-foreground">{meanCell}</span></span> : null}
          <span><span className="text-muted-foreground">Diamond </span><span className="text-foreground">{row.diamond_score != null ? Math.round(row.diamond_score) : "—"}</span></span>
          {actualStr ? <span className="ml-auto text-foreground/90">{actualStr}</span> : null}
        </div>
      </div>
    </div>
  );
}
