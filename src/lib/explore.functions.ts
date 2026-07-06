/**
 * Explore — official MLB Stats API leaderboards.
 *
 * Uses server-side sort + limit so the payload is exactly what the user asked
 * for (Top N by category for the selected group / team / timeframe). Never
 * fabricates rows. "Recent Form" categories query `byDateRange` for the last
 * 14 or 30 days and sort by the anchor metric for the group.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAppMember } from "@/integrations/supabase/member-middleware";
import { isoDateInAppTz, shiftIsoDate, todayInAppTz } from "@/lib/timezone";

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

async function mlbFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${MLB_BASE}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`MLB ${res.status}: ${path}`);
  return (await res.json()) as T;
}

export type ExploreGroup = "hitting" | "pitching";
export type ExploreTimeframe = "season" | "last30" | "last14";

export type ExploreCategory = {
  key: string;
  label: string;
  group: ExploreGroup;
  sortStat: string;          // MLB Stats API sortStat name
  order: "asc" | "desc";
  displayFormat: "int" | "avg3" | "avg2" | "ip" | "raw";
  timeframes?: ExploreTimeframe[]; // if omitted, all 3
};

export const EXPLORE_CATEGORIES: ExploreCategory[] = [
  // Hitters
  { key: "avg",  label: "AVG",         group: "hitting", sortStat: "battingAverage",       order: "desc", displayFormat: "avg3" },
  { key: "obp",  label: "OBP",         group: "hitting", sortStat: "onBasePercentage",     order: "desc", displayFormat: "avg3" },
  { key: "slg",  label: "SLG",         group: "hitting", sortStat: "sluggingPercentage",   order: "desc", displayFormat: "avg3" },
  { key: "ops",  label: "OPS",         group: "hitting", sortStat: "onBasePlusSlugging",   order: "desc", displayFormat: "avg3" },
  { key: "h",    label: "Hits",        group: "hitting", sortStat: "hits",                 order: "desc", displayFormat: "int" },
  { key: "hr",   label: "Home Runs",   group: "hitting", sortStat: "homeRuns",             order: "desc", displayFormat: "int" },
  { key: "tb",   label: "Total Bases", group: "hitting", sortStat: "totalBases",           order: "desc", displayFormat: "int" },
  { key: "rbi",  label: "RBI",         group: "hitting", sortStat: "rbi",                  order: "desc", displayFormat: "int" },
  { key: "r",    label: "Runs",        group: "hitting", sortStat: "runs",                 order: "desc", displayFormat: "int" },
  { key: "bb",   label: "Walks",       group: "hitting", sortStat: "baseOnBalls",          order: "desc", displayFormat: "int" },
  { key: "so",   label: "Strikeouts",  group: "hitting", sortStat: "strikeOuts",           order: "asc",  displayFormat: "int" },
  { key: "form", label: "Recent Form (14d OPS)", group: "hitting", sortStat: "onBasePlusSlugging", order: "desc", displayFormat: "avg3", timeframes: ["last14"] },
  // Pitchers
  { key: "era",  label: "ERA",              group: "pitching", sortStat: "earnedRunAverage", order: "asc",  displayFormat: "avg2" },
  { key: "whip", label: "WHIP",             group: "pitching", sortStat: "whip",             order: "asc",  displayFormat: "avg2" },
  { key: "ip",   label: "Innings Pitched",  group: "pitching", sortStat: "inningsPitched",   order: "desc", displayFormat: "ip" },
  { key: "k",    label: "Strikeouts",       group: "pitching", sortStat: "strikeOuts",       order: "desc", displayFormat: "int" },
  { key: "pbb",  label: "Walks",            group: "pitching", sortStat: "baseOnBalls",      order: "asc",  displayFormat: "int" },
  { key: "hra",  label: "Home Runs Allowed",group: "pitching", sortStat: "homeRuns",         order: "asc",  displayFormat: "int" },
  { key: "ha",   label: "Hits Allowed",     group: "pitching", sortStat: "hits",             order: "asc",  displayFormat: "int" },
  { key: "pform",label: "Recent Form (14d ERA)", group: "pitching", sortStat: "earnedRunAverage", order: "asc", displayFormat: "avg2", timeframes: ["last14"] },
];

export type ExploreRow = {
  rank: number;
  mlbId: number;
  name: string;
  team: string | null;
  teamId: number | null;
  position: string | null;
  value: string;
  // context columns
  games: number | null;
  pa: number | null;   // hitters only
  ip: number | null;   // pitchers only
};

export type ExplorePayload = {
  group: ExploreGroup;
  timeframe: ExploreTimeframe;
  categoryKey: string;
  categoryLabel: string;
  season: number;
  startDate: string | null;
  endDate: string | null;
  teamId: number | null;
  limit: number;
  rows: ExploreRow[];
  fetchedAt: string;
  windowLabel: string;
};

function currentSeason(): number {
  const d = new Date();
  const month = d.getUTCMonth() + 1;
  return month < 3 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

function fmt(v: unknown, kind: ExploreCategory["displayFormat"]): string {
  if (v == null || v === "") return "—";
  const s = String(v);
  if (kind === "avg3" || kind === "avg2") return s;
  if (kind === "ip") return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return String(Math.round(n));
}

export type ExploreTeamOption = { id: number; name: string; abbreviation: string };

export const listMlbTeams = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .handler(async (): Promise<ExploreTeamOption[]> => {
    const json = await mlbFetch<any>(`/teams?sportId=1&activeStatus=Yes`);
    const teams: ExploreTeamOption[] = (json.teams ?? [])
      .filter((t: any) => t.sport?.id === 1)
      .map((t: any) => ({ id: t.id, name: t.name, abbreviation: t.abbreviation ?? "" }))
      .sort((a: ExploreTeamOption, b: ExploreTeamOption) => a.name.localeCompare(b.name));
    return teams;
  });

export const getExploreLeaderboard = createServerFn({ method: "GET" })
  .middleware([requireAppMember])
  .inputValidator((data: {
    group: ExploreGroup;
    timeframe: ExploreTimeframe;
    categoryKey: string;
    teamId?: number | null;
    limit?: number;
  }) => data)
  .handler(async ({ data }): Promise<ExplorePayload> => {
    const cat = EXPLORE_CATEGORIES.find((c) => c.key === data.categoryKey && c.group === data.group);
    if (!cat) throw new Error(`Unknown category: ${data.group}/${data.categoryKey}`);
    const effectiveTimeframe: ExploreTimeframe = (cat.timeframes && !cat.timeframes.includes(data.timeframe))
      ? cat.timeframes[0]
      : data.timeframe;
    const limit = Math.min(Math.max(data.limit ?? 25, 1), 500);
    const season = currentSeason();
    const today = todayInAppTz();

    let statsMode: "season" | "byDateRange" = "season";
    let startDate: string | null = null;
    let endDate: string | null = null;
    let windowLabel = `Season ${season}`;
    if (effectiveTimeframe === "last30") {
      statsMode = "byDateRange";
      endDate = today;
      startDate = shiftIsoDate(today, -30);
      windowLabel = `Last 30 Days · ${startDate} → ${endDate}`;
    } else if (effectiveTimeframe === "last14") {
      statsMode = "byDateRange";
      endDate = today;
      startDate = shiftIsoDate(today, -14);
      windowLabel = `Last 14 Days · ${startDate} → ${endDate}`;
    }

    const params = new URLSearchParams({
      stats: statsMode,
      group: cat.group,
      sportIds: "1",
      season: String(season),
      gameType: "R",
      sortStat: cat.sortStat,
      order: cat.order,
      limit: String(limit),
    });
    if (statsMode === "byDateRange") {
      params.set("startDate", startDate!);
      params.set("endDate", endDate!);
    }
    if (data.teamId) params.set("teamId", String(data.teamId));
    // Only qualified players count for rate stats (matches statsapi convention)
    if (["avg3", "avg2"].includes(cat.displayFormat)) params.set("playerPool", "Qualified");

    const json = await mlbFetch<any>(`/stats?${params.toString()}`);
    const splits: any[] = json?.stats?.[0]?.splits ?? [];

    const rows: ExploreRow[] = splits.slice(0, limit).map((s, idx) => {
      const stat = s.stat ?? {};
      const rawValue: unknown =
        cat.sortStat === "battingAverage" ? stat.avg
        : cat.sortStat === "onBasePercentage" ? stat.obp
        : cat.sortStat === "sluggingPercentage" ? stat.slg
        : cat.sortStat === "onBasePlusSlugging" ? stat.ops
        : cat.sortStat === "hits" ? stat.hits
        : cat.sortStat === "homeRuns" ? stat.homeRuns
        : cat.sortStat === "totalBases" ? stat.totalBases
        : cat.sortStat === "rbi" ? stat.rbi
        : cat.sortStat === "runs" ? stat.runs
        : cat.sortStat === "baseOnBalls" ? stat.baseOnBalls
        : cat.sortStat === "strikeOuts" ? stat.strikeOuts
        : cat.sortStat === "earnedRunAverage" ? stat.era
        : cat.sortStat === "whip" ? stat.whip
        : cat.sortStat === "inningsPitched" ? stat.inningsPitched
        : null;
      return {
        rank: idx + 1,
        mlbId: Number(s.player?.id ?? 0),
        name: s.player?.fullName ?? "—",
        team: s.team?.abbreviation ?? s.team?.name ?? null,
        teamId: s.team?.id ?? null,
        position: s.position?.abbreviation ?? null,
        value: fmt(rawValue, cat.displayFormat),
        games: stat.gamesPlayed != null ? Number(stat.gamesPlayed) : null,
        pa: cat.group === "hitting" && stat.plateAppearances != null ? Number(stat.plateAppearances) : null,
        ip: cat.group === "pitching" && stat.inningsPitched != null ? Number(stat.inningsPitched) : null,
      };
    }).filter((r: ExploreRow) => r.mlbId > 0);

    return {
      group: cat.group,
      timeframe: effectiveTimeframe,
      categoryKey: cat.key,
      categoryLabel: cat.label,
      season,
      startDate,
      endDate,
      teamId: data.teamId ?? null,
      limit,
      rows,
      fetchedAt: new Date().toISOString(),
      windowLabel,
    };
  });

// Silence unused import warning if only some helpers used
export const _internal = { isoDateInAppTz };
