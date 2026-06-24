import { Link } from "@tanstack/react-router";
import type { GameSummary } from "@/lib/mlb.functions";

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function ScoreCard({ game }: { game: GameSummary }) {
  const winner =
    game.isFinal && game.away.score !== null && game.home.score !== null
      ? game.away.score > game.home.score
        ? "away"
        : game.home.score > game.away.score
          ? "home"
          : null
      : null;

  return (
    <Link
      to="/matchups/$gamePk"
      params={{ gamePk: String(game.gamePk) }}
      className="group block rounded-lg border border-border/70 bg-card p-4 transition-colors hover:border-primary/40 hover:bg-card/80"
    >
      <div className="mb-3 flex items-center justify-between">
        <StatusPill game={game} />
        <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground" suppressHydrationWarning>
          {game.venue || formatTime(game.startTimeUtc)}
        </span>
      </div>

      <TeamRow
        side="away"
        teamId={game.away.id}
        abbrev={game.away.abbreviation}
        name={game.away.name}
        record={game.away.record}
        score={game.away.score}
        line={game.away.line}
        pitcher={game.awayProbablePitcher}
        isWinner={winner === "away"}
        isFinal={game.isFinal}
        showLine={game.isLive || game.isFinal}
      />
      <div className="my-2 h-px bg-border/60" />
      <TeamRow
        side="home"
        teamId={game.home.id}
        abbrev={game.home.abbreviation}
        name={game.home.name}
        record={game.home.record}
        score={game.home.score}
        line={game.home.line}
        pitcher={game.homeProbablePitcher}
        isWinner={winner === "home"}
        isFinal={game.isFinal}
        showLine={game.isLive || game.isFinal}
      />

      {game.live ? <LiveGameDetails game={game} /> : null}
    </Link>
  );
}

function StatusPill({ game }: { game: GameSummary }) {
  if (game.isLive) {
    return (
      <span className="mono inline-flex items-center gap-1.5 rounded-full bg-live/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-live">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
        Live · {game.inningHalf === "Top" ? "Top" : "Bot"} {game.inning ?? ""}
      </span>
    );
  }
  if (game.isFinal) {
    return (
      <span className="mono inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        Final
      </span>
    );
  }
  return (
    <span className="mono inline-flex rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground" suppressHydrationWarning>
      {formatTime(game.startTimeUtc)}
    </span>
  );
}

function TeamRow({
  abbrev, name, record, score, line, pitcher, isWinner, isFinal, showLine,
}: {
  side: "home" | "away";
  teamId: number;
  abbrev: string;
  name: string;
  record: string;
  score: number | null;
  line: GameSummary["home"]["line"];
  pitcher: string | null;
  isWinner: boolean;
  isFinal: boolean;
  showLine: boolean;
}) {
  const dim = isFinal && !isWinner;
  return (
    <div className={`flex items-center justify-between ${dim ? "opacity-55" : ""}`}>
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-8 w-10 items-center justify-center rounded bg-secondary font-display text-sm font-bold text-foreground">
          {abbrev || "?"}
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium">{name}</div>
          <div className="mono text-[11px] text-muted-foreground">
            {record}{pitcher ? ` · ${pitcher}` : ""}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {showLine ? (
          <div className="hidden grid-cols-2 gap-x-2 text-right mono text-[10px] uppercase tracking-widest text-muted-foreground sm:grid">
            <span>H {line.hits ?? "—"}</span>
            <span>E {line.errors ?? "—"}</span>
          </div>
        ) : null}
        <div className={`mono text-2xl font-bold tabular-nums ${isWinner ? "text-primary" : ""}`}>
          {score ?? "—"}
        </div>
      </div>
    </div>
  );
}

function LiveGameDetails({ game }: { game: GameSummary }) {
  if (!game.live) return null;
  const count = [
    game.live.balls == null ? null : `${game.live.balls}-${game.live.strikes ?? 0}`,
    game.live.outs == null ? null : `${game.live.outs} out${game.live.outs === 1 ? "" : "s"}`,
    game.live.basesOccupied.length ? game.live.basesOccupied.join(", ") : "Bases empty",
  ].filter(Boolean).join(" · ");

  return (
    <div className="mt-4 space-y-3 border-t border-border/60 pt-3">
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <LiveStat label="Count" value={count || "—"} />
        <LiveStat label="Matchup" value={[game.live.currentBatter, game.live.currentPitcher].filter(Boolean).join(" vs ") || "—"} />
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <TeamLiveStats label={game.away.abbreviation || "Away"} stats={game.live.away} />
        <TeamLiveStats label={game.home.abbreviation || "Home"} stats={game.live.home} />
      </div>

      {game.live.lastPlay ? (
        <div className="rounded-md bg-secondary/70 px-3 py-2 text-xs text-muted-foreground">
          {game.live.lastPlay}
        </div>
      ) : null}

      <LiveLeaders title="Hot bats" players={game.live.battingLeaders} />
      <LiveLeaders title="Pitching lines" players={game.live.pitchingLeaders} />
    </div>
  );
}

function LiveStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/50 px-3 py-2">
      <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="truncate text-foreground">{value}</span>
    </div>
  );
}

function TeamLiveStats({ label, stats }: { label: string; stats: NonNullable<GameSummary["live"]>["home"] }) {
  return (
    <div className="rounded-md bg-secondary/50 px-3 py-2">
      <div className="mb-1 mono text-[10px] font-bold uppercase tracking-widest text-foreground">{label}</div>
      <div className="grid grid-cols-3 gap-1 mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <span>LOB {stats.leftOnBase ?? "—"}</span>
        <span>HR {stats.homeRuns ?? "—"}</span>
        <span>BB {stats.walks ?? "—"}</span>
        <span>K {stats.strikeouts ?? "—"}</span>
        <span>H {stats.hits ?? "—"}</span>
        <span>E {stats.errors ?? "—"}</span>
      </div>
    </div>
  );
}

function LiveLeaders({ title, players }: { title: string; players: NonNullable<GameSummary["live"]>["battingLeaders"] }) {
  if (players.length === 0) return null;
  return (
    <div>
      <div className="mb-1 mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{title}</div>
      <div className="space-y-1">
        {players.map((p) => (
          <div key={`${title}-${p.id}`} className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-foreground">{p.name}</span>
            <span className="mono shrink-0 text-[10px] uppercase tracking-widest text-muted-foreground">{p.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
