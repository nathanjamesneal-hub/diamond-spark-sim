/**
 * ForecastCard — public, single-market default face.
 * Shows ONE primary forecast (At Least 1 Hit) and the official forecast
 * status. Diamond Score is a quiet secondary rank chip.
 *
 * Variants:
 *   - "public" (default): hides raw inputs, secondary markets, debug grids.
 *   - "admin": adds a collapsible "Advanced" section with raw inputs.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { DiamondHitterCard } from "@/lib/projections.functions";
import { DiamondCard } from "@/components/ui/diamond-card";
import { formatTimeInAppTz } from "@/lib/timezone";

type ForecastState = "no_official" | "published" | "locked" | "live" | "final";

type LiveLine = { hits: number; ab: number; inning?: number };
type FinalLine = { hits: number; ab: number };

type Props = {
  card: DiamondHitterCard;
  rank?: number | null;
  state?: ForecastState;
  liveLine?: LiveLine | null;
  finalLine?: FinalLine | null;
  variant?: "public" | "admin";
};

function fmtPct(p: number | null | undefined): string {
  if (p == null || !isFinite(p)) return "—";
  const v = p <= 1 ? p * 100 : p;
  return `${Math.round(v)}%`;
}

function statusLine(state: ForecastState, modelVersion: string, publishedAt: string | null, live?: LiveLine | null, fin?: FinalLine | null) {
  const time = publishedAt ? formatTimeInAppTz(publishedAt) : null;
  switch (state) {
    case "no_official":
      return null;
    case "published":
      return `Lineup-confirmed forecast · ${modelVersion}${time ? ` · ${time}` : ""}`;
    case "locked":
      return `Forecast locked at first pitch · ${modelVersion}`;
    case "live": {
      const inn = live?.inning ? ` through ${live.inning}` : "";
      return `Live · ${live?.hits ?? 0}-for-${live?.ab ?? 0}${inn}`;
    }
    case "final":
      return `Final · ${fin?.hits ?? 0}-for-${fin?.ab ?? 0}`;
  }
}

export function ForecastCard({
  card,
  rank,
  state = "published",
  liveLine,
  finalLine,
  variant = "public",
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const hitProb = card.hit_probability;
  const hitMean: number | null = (card as any).H?.mean ?? null;
  const paMean: number | null = (card as any).PA?.mean ?? null;
  const hasOfficial = state !== "no_official" && hitProb != null;

  return (
    <DiamondCard size="sm" teamAbbr={card.team_abbrev} className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/players/$playerId"
            params={{ playerId: card.player_id }}
            className="display block truncate text-lg leading-tight text-foreground hover:text-primary"
          >
            {card.player_name}
          </Link>
          <div className="mono mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            {card.team_abbrev} @ {card.opp_abbrev}
            {card.batting_order ? ` · #${card.batting_order}` : ""}
            {card.first_pitch_at ? ` · ${formatTimeInAppTz(card.first_pitch_at)}` : ""}
          </div>
        </div>
        {hasOfficial && rank != null ? (
          <div className="shrink-0 text-right">
            <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">Diamond Rank</div>
            <div className="mono text-base font-bold tabular-nums text-primary">#{rank}</div>
          </div>
        ) : null}
      </div>

      {/* Primary forecast */}
      {hasOfficial ? (
        <div className="rounded-md border border-border/60 bg-secondary/30 px-3 py-2">
          <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">
            Primary forecast
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-3">
            <span className="display text-base text-foreground">At Least 1 Hit</span>
            <span className="mono text-2xl font-bold tabular-nums text-primary">{fmtPct(hitProb)}</span>
          </div>
          <div className="mono mt-1 text-[10px] text-muted-foreground">
            {hitMean != null ? `${hitMean.toFixed(2)} projected hits` : "—"}
            {paMean != null ? ` · ${paMean.toFixed(1)} projected PA` : ""}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border/60 bg-card/40 px-3 py-3">
          <div className="display text-sm text-foreground">Awaiting confirmed lineups</div>
          <div className="mono mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
            No official Diamond forecast published yet.
          </div>
        </div>
      )}

      {/* Status line */}
      {hasOfficial ? (
        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {statusLine(state, card.model_version, card.last_refresh_at ?? null, liveLine, finalLine)}
        </div>
      ) : null}

      {/* Secondary detail (quiet) */}
      {hasOfficial ? (
        <div className="flex items-center justify-between border-t border-border/40 pt-2">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Diamond Score {card.diamond_score != null ? Math.round(card.diamond_score) : "—"}
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mono text-[10px] uppercase tracking-widest text-primary hover:underline"
          >
            {expanded ? "Hide" : "Why ▾"}
          </button>
        </div>
      ) : null}

      {expanded && hasOfficial ? (
        <div className="rounded-md border border-border/40 bg-card/60 p-2 text-xs text-foreground/80">
          {card.inputs_narrative ?? "Lineup-confirmed projection from the active Diamond model."}
        </div>
      ) : null}

      {variant === "admin" && expanded ? (
        <div className="mono rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[10px] uppercase tracking-widest text-amber-300">
          Admin — raw inputs available on the player page.
        </div>
      ) : null}
    </DiamondCard>
  );
}
