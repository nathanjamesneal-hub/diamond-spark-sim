/**
 * ForecastBoard — dense, sortable, filterable list of official forecasts.
 *
 * - Public visibility: projection_class='official' + forecast_status in
 *   {published, locked, live, final}. preview is never shown.
 * - Click a row to open the detail drawer (lazy, read-only).
 * - Optional `compact` mode: top-N rows, no controls (used on the Today page).
 */
import { useMemo, useState } from "react";
import type {
  DiamondHitterCard,
  DiamondPitcherCard,
  DiamondScoresPayload,
  ForecastBoardStatus,
} from "@/lib/projections.functions";
import { BoardControls, type BoardSort, type BoardStatusFilter } from "./board-controls";
import { ForecastRow, type BoardCard } from "./forecast-row";
import { ForecastDetailDrawer } from "./forecast-detail-drawer";
import {
  hitterMean, hitterProb, isPitcherMarket, pitcherMean, pitcherProb, type Market,
} from "./market";

type ControlledState = {
  market: Market;
  sort: BoardSort;
  statusFilter: BoardStatusFilter;
  team: string | null;
  search: string;
};

type Props = {
  payload: DiamondScoresPayload;
  /** Controlled state — when omitted the board manages its own. */
  state?: ControlledState;
  onState?: (s: Partial<ControlledState>) => void;
  /** Compact mode: hide controls, show only top-N rows, render footer link. */
  compact?: boolean;
  topN?: number;
};

const PUBLIC_STATUSES: ForecastBoardStatus[] = ["published", "locked", "live", "final", "preview"];

export function ForecastBoard({ payload, state, onState, compact, topN }: Props) {
  const [internal, setInternal] = useState<ControlledState>({
    market: "hit", sort: "diamond", statusFilter: "all", team: null, search: "",
  });
  const s = state ?? internal;
  const setS = (patch: Partial<ControlledState>) => {
    if (onState) onState(patch);
    else setInternal((prev) => ({ ...prev, ...patch }));
  };

  const [open, setOpen] = useState<BoardCard | null>(null);

  const cards = useMemo<BoardCard[]>(() => {
    const pitcherMode = isPitcherMarket(s.market);
    const rows: BoardCard[] = pitcherMode
      ? payload.pitchers.map((row) => ({ kind: "pitcher" as const, row }))
      : payload.hitters.map((row) => ({ kind: "hitter" as const, row }));
    return rows;
  }, [payload, s.market]);

  const filtered = useMemo(() => {
    const q = s.search.trim().toLowerCase();
    let out = cards.filter((c) => {
      const status = c.row.forecast_status;
      // Public board: never show preview or no_official.
      if (!PUBLIC_STATUSES.includes(status)) return false;
      // Status chip
      if (s.statusFilter === "upcoming" && c.row.game_display_state !== "upcoming") return false;
      if (s.statusFilter === "live" && c.row.game_display_state !== "live") return false;
      if (s.statusFilter === "final" && c.row.game_display_state !== "final") return false;
      // Team filter
      if (s.team && c.row.team_abbrev !== s.team) return false;
      // Search
      if (q && !c.row.player_name.toLowerCase().includes(q)) return false;
      return true;
    });
    // Sort
    out = out.slice().sort((a, b) => sortCmp(a, b, s.sort, s.market));
    if (topN) out = out.slice(0, topN);
    return out;
  }, [cards, s.statusFilter, s.team, s.search, s.sort, s.market, topN]);

  return (
    <div className="space-y-3">
      {!compact ? (
        <BoardControls
          market={s.market}
          sort={s.sort}
          statusFilter={s.statusFilter}
          team={s.team}
          search={s.search}
          teams={payload.teams}
          onMarket={(m) => setS({ market: m })}
          onSort={(v) => setS({ sort: v })}
          onStatus={(v) => setS({ statusFilter: v })}
          onTeam={(v) => setS({ team: v })}
          onSearch={(v) => setS({ search: v })}
        />
      ) : null}

      {/* Column header */}
      <div className="mono hidden border-b border-border/50 pb-1.5 sm:grid sm:items-center sm:gap-2 sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_42px_56px_56px_42px_64px_72px_minmax(0,1.1fr)] text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
        <span>Player</span>
        <span>Game</span>
        <span className="text-center">BO</span>
        <span className="text-right">Prob</span>
        <span className="text-right">Mean</span>
        <span className="text-right">PA</span>
        <span className="text-right">Diamond</span>
        <span className="text-right">Status</span>
        <span className="text-right">Actual</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-1">
          {filtered.map((c, i) => (
            <ForecastRow
              key={`${c.row.player_id}:${c.row.game_id}:${c.row.model_version}`}
              card={c}
              rank={i + 1}
              market={s.market}
              onOpen={() => setOpen(c)}
            />
          ))}
        </div>
      )}

      <ForecastDetailDrawer
        open={!!open}
        onClose={() => setOpen(null)}
        card={open}
        market={s.market}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border/50 bg-card/30 p-8 text-center">
      <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Awaiting confirmed lineups</div>
      <p className="mt-2 text-xs text-muted-foreground">No official Diamond forecasts published yet.</p>
    </div>
  );
}

function sortCmp(a: BoardCard, b: BoardCard, sort: BoardSort, market: Market): number {
  if (sort === "time") {
    const at = a.row.first_pitch_at ? Date.parse(a.row.first_pitch_at) : Infinity;
    const bt = b.row.first_pitch_at ? Date.parse(b.row.first_pitch_at) : Infinity;
    return at - bt;
  }
  const pick = (c: BoardCard): number => {
    const isHitter = c.kind === "hitter";
    switch (sort) {
      case "diamond": return c.row.diamond_score ?? -Infinity;
      case "prob":    return (isHitter ? hitterProb(c.row as DiamondHitterCard, market) : pitcherProb(c.row as DiamondPitcherCard, market)) ?? -Infinity;
      case "mean":    return (isHitter ? hitterMean(c.row as DiamondHitterCard, market) : pitcherMean(c.row as DiamondPitcherCard, market)) ?? -Infinity;
      case "pa":      return (isHitter ? (c.row as DiamondHitterCard).projected_pa ?? -Infinity : (c.row as DiamondPitcherCard).projected_bf ?? -Infinity);
      default: return -Infinity;
    }
  };
  return pick(b) - pick(a);
}
