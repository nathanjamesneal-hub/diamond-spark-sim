import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import {
  getLineupStatus,
  refreshLineupsForGame,
  runEngineForGame,
  lockGame,
  unlockGame,
  type LineupStatusRow,
  type PipelineBadge,
} from "@/lib/lineup-status.functions";
import { supabase } from "@/integrations/supabase/client";
import { formatDateTimeInAppTz, formatTimeInAppTz, shiftIsoDate } from "@/lib/timezone";

const searchSchema = z.object({ date: z.string().optional() });

function statusQuery(date: string | undefined) {
  return queryOptions({
    queryKey: ["lineup-status", date ?? "today"],
    queryFn: () => getLineupStatus({ data: date ? { date } : {} }),
    staleTime: 30_000,
  });
}

export const Route = createFileRoute("/lineup-status")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Lineup Status · Diamond" },
      { name: "description", content: "Per-game pipeline status: schedule, lineups, pitchers, DNA, projections." },
    ],
  }),
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => ({ date: search.date }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(statusQuery(deps.date)),
  component: LineupStatusPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-destructive">Couldn't load lineup status: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">Not found.</div>,
});

function LineupStatusPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(statusQuery(search.date));
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getUser().then(async ({ data: u }) => {
      if (!u.user) return;
      const { data: ok } = await supabase.rpc("has_role", { _user_id: u.user.id, _role: "admin" });
      if (active) setIsAdmin(!!ok);
    });
    return () => { active = false; };
  }, []);

  const setDate = (d: string | undefined) =>
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, date: d }) });

  const s = data.summary;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mono text-[11px] uppercase tracking-[0.25em] text-primary">Pipeline · Lineup Status</div>
          <h1 className="font-display text-3xl font-bold tracking-tight">{data.date}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Every game on the slate with lineup, pitcher, DNA, and projection state.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateBtn onClick={() => setDate(shiftIsoDate(data.date, -1))}>← Prev</DateBtn>
          <DateBtn onClick={() => setDate(undefined)}>Today</DateBtn>
          <DateBtn onClick={() => setDate(shiftIsoDate(data.date, 1))}>Next →</DateBtn>
        </div>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryBlock label="Games scheduled" value={s.games_scheduled} />
        <SummaryBlock label="With lineups" value={`${s.games_with_lineups} / ${s.games_scheduled}`} />
        <SummaryBlock label="Confirmed lineups" value={`${s.games_with_confirmed_lineups} / ${s.games_scheduled}`} />
        <SummaryBlock label="Starting pitchers" value={`${s.games_with_starting_pitchers} / ${s.games_scheduled}`} />
        <SummaryBlock label="With projections" value={`${s.games_with_projections} / ${s.games_scheduled}`} />
        <SummaryBlock label="Locked" value={`${s.games_locked} / ${s.games_scheduled}`} />
        <SummaryBlock label="Last cron refresh" value={s.last_refresh_at ? formatDateTimeInAppTz(s.last_refresh_at) : "—"} />
        <SummaryBlock label="Last engine run" value={s.last_engine_run_at ? formatDateTimeInAppTz(s.last_engine_run_at) : "—"} />
      </div>

      {data.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/40 p-10 text-center text-sm text-muted-foreground">
          No games scheduled for {data.date}. Try importing the schedule from /admin.
        </div>
      ) : (
        <div className="space-y-3">
          {data.rows.map((row) => (
            <GameRow key={row.game_id} row={row} isAdmin={isAdmin} />
          ))}
        </div>
      )}
    </div>
  );
}

function GameRow({ row, isAdmin }: { row: LineupStatusRow; isAdmin: boolean }) {
  const qc = useQueryClient();
  const refresh = useServerFn(refreshLineupsForGame);
  const runEngine = useServerFn(runEngineForGame);
  const lock = useServerFn(lockGame);
  const unlock = useServerFn(unlockGame);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(key: string, fn: () => Promise<any>) {
    setBusy(key);
    setMsg(null);
    try {
      const res = await fn();
      setMsg({
        ok: res?.ok !== false,
        text:
          res?.ok === false
            ? `Error: ${res?.error ?? "unknown"}`
            : res?.projectionsInserted != null
              ? `Inserted ${res.projectionsInserted} projections`
              : res?.changed === false
                ? "No lineup changes detected"
                : "Done",
      });
      qc.invalidateQueries({ queryKey: ["lineup-status"] });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-display text-base font-bold">{row.label}</span>
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground" suppressHydrationWarning>
              {row.first_pitch_at ? formatTimeInAppTz(row.first_pitch_at) : "—"}
            </span>
            {row.game_status ? (
              <span className="mono rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
                {row.game_status}
              </span>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {row.badges.map((b) => (
              <BadgePill key={b} kind={b} />
            ))}
          </div>
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <ActionBtn disabled={busy != null} onClick={() => call("refresh", () => refresh({ data: { gameId: row.game_id } }))}>
              {busy === "refresh" ? "…" : "Refresh lineups"}
            </ActionBtn>
            <ActionBtn disabled={busy != null} onClick={() => call("engine", () => runEngine({ data: { gameId: row.game_id } }))}>
              {busy === "engine" ? "…" : "Run engine"}
            </ActionBtn>
            <ActionBtn
              disabled={busy != null || row.locked_at != null}
              onClick={() => call("lock", () => lock({ data: { gameId: row.game_id } }))}
            >
              {busy === "lock" ? "…" : row.locked_at ? "Locked" : "Lock"}
            </ActionBtn>
            {row.locked_at ? (
              <ActionBtn
                disabled={busy != null}
                onClick={() => call("unlock", () => unlock({ data: { gameId: row.game_id } }))}
              >
                {busy === "unlock" ? "…" : "Unlock"}
              </ActionBtn>
            ) : null}
          </div>
        ) : null}
      </div>

      {msg ? (
        <div className={`mono mt-2 text-[11px] ${msg.ok ? "text-edge" : "text-destructive"}`}>{msg.text}</div>
      ) : null}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <SidePanel label="Away" side={row.away} />
        <SidePanel label="Home" side={row.home} />
      </div>

      <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
        <KV k="Lineup source" v={row.lineup_source ?? "—"} />
        <KV k="Lineup confidence" v={row.lineup_confidence == null ? "—" : String(row.lineup_confidence)} />
        <KV k="Hitters set" v={`${row.hitters_set} / ${row.hitters_expected}`} />
        <KV k="DNA non-default" v={`${row.dna_hitters_with_data} / ${row.dna_hitters_total}`} />
        <KV k="Last refresh" v={row.last_refresh_at ? formatDateTimeInAppTz(row.last_refresh_at) : "—"} />
        <KV
          k="Latest projection"
          v={row.latest_projection_at ? formatDateTimeInAppTz(row.latest_projection_at) : "—"}
        />
        <KV k="Model version" v={row.projection_model_version ?? "—"} />
        <KV k="Active projections" v={String(row.active_projection_count)} />
      </div>
    </div>
  );
}

function SidePanel({ label, side }: { label: string; side: LineupStatusRow["home"] }) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 p-3">
      <div className="flex items-center justify-between">
        <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {label} · {side.team_abbrev}
        </span>
        <LineupStatusPill status={side.lineup_status} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">Hitters set</div>
          <div className="font-semibold">{side.hitters_set} / 9</div>
        </div>
        <div>
          <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">Source</div>
          <div className="font-semibold">{side.lineup_source ?? "—"}</div>
        </div>
        <div className="col-span-2">
          <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">Starting pitcher</div>
          <div className="font-semibold">
            {side.starting_pitcher_name ?? <span className="text-destructive">Missing</span>}
            {side.starting_pitcher_name ? (
              <span className="mono ml-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                {side.starting_pitcher_confirmed ? "confirmed" : "probable"}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function LineupStatusPill({ status }: { status: LineupStatusRow["home"]["lineup_status"] }) {
  const map: Record<LineupStatusRow["home"]["lineup_status"], { l: string; cls: string }> = {
    missing: { l: "Missing", cls: "bg-destructive/15 text-destructive" },
    projected: { l: "Projected", cls: "bg-secondary text-foreground" },
    confirmed: { l: "Confirmed", cls: "bg-edge/15 text-edge" },
    locked: { l: "Locked", cls: "bg-primary/15 text-primary" },
  };
  const m = map[status];
  return (
    <span className={`mono rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${m.cls}`}>
      {m.l}
    </span>
  );
}

const BADGE_META: Record<PipelineBadge, { label: string; cls: string }> = {
  missing_schedule:       { label: "Missing schedule",       cls: "bg-destructive/15 text-destructive" },
  missing_pitchers:       { label: "Missing pitchers",       cls: "bg-destructive/15 text-destructive" },
  missing_lineups:        { label: "Missing lineups",        cls: "bg-destructive/15 text-destructive" },
  missing_dna:            { label: "Missing DNA",            cls: "bg-destructive/15 text-destructive" },
  ready_to_project:       { label: "Ready to project",       cls: "bg-primary/15 text-primary" },
  projected:              { label: "Projected",              cls: "bg-secondary text-foreground" },
  confirmed:              { label: "Confirmed",              cls: "bg-edge/15 text-edge" },
  locked:                 { label: "Locked",                 cls: "bg-primary/20 text-primary" },
  projections_available:  { label: "Projections available",  cls: "bg-edge/15 text-edge" },
  no_projections:         { label: "No projections",         cls: "bg-secondary text-muted-foreground" },
};

function BadgePill({ kind }: { kind: PipelineBadge }) {
  const m = BADGE_META[kind];
  return (
    <span className={`mono rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${m.cls}`}>
      {m.label}
    </span>
  );
}

function SummaryBlock({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border/40 bg-card/40 p-3">
      <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md bg-secondary/30 px-2 py-1.5">
      <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{k}</div>
      <div className="mono tabular-nums">{v}</div>
    </div>
  );
}

function DateBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mono rounded-md border border-border/60 px-2.5 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
    >
      {children}
    </button>
  );
}

function ActionBtn({
  children, onClick, disabled,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="mono rounded-md border border-border/60 bg-background px-2 py-1 text-[10px] font-bold uppercase tracking-widest hover:bg-secondary disabled:opacity-40"
    >
      {children}
    </button>
  );
}
