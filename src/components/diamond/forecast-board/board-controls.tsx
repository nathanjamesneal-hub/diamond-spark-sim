/**
 * Board controls bar — sort, status, team, search, market.
 * URL-synced via parent (search params live on the route).
 */
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  HITTER_MARKETS, PITCHER_MARKETS, MARKET_META, isPitcherMarket, type Market,
} from "./market";

export type BoardSort = "diamond" | "prob" | "mean" | "pa" | "time";
export type BoardStatusFilter = "all" | "upcoming" | "live" | "final";

type Props = {
  market: Market;
  sort: BoardSort;
  statusFilter: BoardStatusFilter;
  team: string | null;
  search: string;
  teams: { id: string; abbrev: string }[];
  onMarket: (m: Market) => void;
  onSort: (s: BoardSort) => void;
  onStatus: (s: BoardStatusFilter) => void;
  onTeam: (t: string | null) => void;
  onSearch: (q: string) => void;
};

const STATUS_CHIPS: { v: BoardStatusFilter; label: string }[] = [
  { v: "all",      label: "All" },
  { v: "upcoming", label: "Upcoming" },
  { v: "live",     label: "Live" },
  { v: "final",    label: "Final" },
];

export function BoardControls({
  market, sort, statusFilter, team, search, teams,
  onMarket, onSort, onStatus, onTeam, onSearch,
}: Props) {
  const isPitcher = isPitcherMarket(market);

  return (
    <div className="space-y-3">
      {/* Market toggle */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mono mr-1 text-[10px] uppercase tracking-widest text-muted-foreground">Market</span>
        {[...HITTER_MARKETS, "pitcher" as const].map((m) => {
          const isOn = m === "pitcher" ? isPitcher : market === m;
          const label = m === "pitcher" ? "Pitcher" : MARKET_META[m as Market].label;
          return (
            <button
              key={m}
              type="button"
              onClick={() => onMarket(m === "pitcher" ? "pitcher_k" : m as Market)}
              className={`mono rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest transition-colors ${
                isOn
                  ? "border-primary/60 bg-primary/15 text-primary"
                  : "border-border/60 bg-card/50 text-muted-foreground hover:text-foreground"
              }`}
            >{label}</button>
          );
        })}
      </div>

      {/* Pitcher sub-toggle */}
      {isPitcher ? (
        <div className="flex flex-wrap items-center gap-1.5 pl-1">
          <span className="mono mr-1 text-[10px] uppercase tracking-widest text-muted-foreground">Pitcher market</span>
          {PITCHER_MARKETS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onMarket(m)}
              className={`mono rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-widest transition-colors ${
                market === m
                  ? "border-primary/60 bg-primary/15 text-primary"
                  : "border-border/40 bg-card/30 text-muted-foreground hover:text-foreground"
              }`}
            >
              {MARKET_META[m].label.replace("Pitcher · ", "")}
            </button>
          ))}
        </div>
      ) : null}

      {/* Sort / Status / Team / Search */}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1.2fr]">
        <Select value={sort} onValueChange={(v) => onSort(v as BoardSort)}>
          <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Sort" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="diamond">Sort · Diamond Score</SelectItem>
            <SelectItem value="prob">Sort · Probability</SelectItem>
            <SelectItem value="mean">Sort · Projected Mean</SelectItem>
            <SelectItem value="pa">Sort · Projected PA</SelectItem>
            <SelectItem value="time">Sort · Game Time</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex flex-wrap items-center gap-1">
          {STATUS_CHIPS.map((c) => (
            <button
              key={c.v}
              type="button"
              onClick={() => onStatus(c.v)}
              className={`mono rounded-md border px-2 py-1 text-[10px] uppercase tracking-widest transition-colors ${
                statusFilter === c.v
                  ? "border-primary/60 bg-primary/15 text-primary"
                  : "border-border/50 bg-card/40 text-muted-foreground hover:text-foreground"
              }`}
            >{c.label}</button>
          ))}
        </div>

        <Select value={team ?? "all"} onValueChange={(v) => onTeam(v === "all" ? null : v)}>
          <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Team" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All teams</SelectItem>
            {teams.map((t) => <SelectItem key={t.abbrev} value={t.abbrev}>{t.abbrev}</SelectItem>)}
          </SelectContent>
        </Select>

        <input
          type="search"
          placeholder="Search player…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="mono h-9 rounded-md border border-border/60 bg-card/40 px-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
      </div>
    </div>
  );
}
