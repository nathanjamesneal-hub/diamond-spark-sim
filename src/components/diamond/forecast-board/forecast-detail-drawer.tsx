/**
 * Forecast Board detail drawer.
 *
 * READ-ONLY. Lazily fetches `getForecastBoardDetail` for the selected
 * (player, game, modelVersion). NEVER triggers simulation, lifecycle
 * publishing, or lineup refresh.
 */
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  getForecastBoardDetail,
  type ForecastBoardDetail,
  type ForecastBoardStatus,
} from "@/lib/projections.functions";
import { formatTimeInAppTz } from "@/lib/timezone";
import type { BoardCard } from "./forecast-row";
import { MARKET_META, type Market, formatActual } from "./market";

type Props = {
  open: boolean;
  onClose: () => void;
  card: BoardCard | null;
  market: Market;
};

function pct(p: number | null | undefined): string {
  if (p == null || !isFinite(p)) return "—";
  const v = p <= 1 ? p * 100 : p;
  return `${(v).toFixed(1)}%`;
}
function num(n: number | null | undefined, digits = 2): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(digits);
}

function statusLabel(s: ForecastBoardStatus): string {
  switch (s) {
    case "no_official": return "Awaiting confirmed lineups";
    case "published":   return "Published";
    case "locked":      return "Locked at first pitch";
    case "live":        return "Live · locked";
    case "final":       return "Final · locked";
  }
}

export function ForecastDetailDrawer({ open, onClose, card, market }: Props) {
  const enabled = open && !!card;
  const playerId = card?.row.player_id ?? null;
  const gameId = card?.row.game_id ?? null;
  const modelVersion = card?.row.model_version;

  const detailQ = useQuery({
    queryKey: ["forecast-board-detail", playerId, gameId, modelVersion],
    queryFn: () => getForecastBoardDetail({ data: { playerId: playerId!, gameId: gameId!, modelVersion } }),
    enabled,
    staleTime: 30_000,
  });

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md md:max-w-lg">
        {!card ? (
          <div className="p-6 text-sm text-muted-foreground">No forecast selected.</div>
        ) : (
          <DrawerBody card={card} market={market} detail={detailQ.data ?? null} loading={detailQ.isLoading} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({
  card, market, detail, loading,
}: { card: BoardCard; market: Market; detail: ForecastBoardDetail | null; loading: boolean }) {
  const row = card.row as any;
  const meta = MARKET_META[market];
  const status = (detail?.forecast.status ?? row.forecast_status) as ForecastBoardStatus;
  const role = card.kind;

  return (
    <>
      <SheetHeader className="border-b border-border/50 pb-3">
        <SheetTitle className="font-display text-xl">{row.player_name}</SheetTitle>
        <div className="mono mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          {row.team_abbrev} @ {row.opp_abbrev || "—"}
          {role === "hitter" && row.batting_order ? ` · #${row.batting_order}` : ""}
          {row.first_pitch_at ? ` · ${formatTimeInAppTz(row.first_pitch_at)}` : ""}
        </div>
        <div className="mono mt-1 text-[10px] uppercase tracking-widest text-primary">
          {meta.label} · {statusLabel(status)}
        </div>
      </SheetHeader>

      {/* Primary metric */}
      <Section title="Primary forecast">
        <div className="grid grid-cols-3 gap-3">
          <Metric label={`${meta.label} probability`} value={pct(detail
            ? (role === "hitter"
                ? (market === "hit" ? (row.hit_probability) : market === "hr" ? row.hr_probability : market === "tb" ? row.total_base_probability : row.rbi_probability)
                : (market === "pitcher_win" ? row.pitcher_win_probability : market === "pitcher_qs" ? row.quality_start_probability : null))
            : null)}
          />
          <Metric label={`Mean ${meta.meanUnit || meta.meanLabel}`} value={num(
            role === "hitter"
              ? (market === "hit" ? row.hit_mean : market === "hr" ? row.hr_mean : market === "tb" ? row.tb_mean : row.rbi_mean)
              : (market === "pitcher_k" ? row.k_mean : market === "pitcher_outs" ? row.projected_outs : market === "pitcher_bb" ? row.bb_mean : null),
            market === "pitcher_outs" || market === "pitcher_k" || market === "pitcher_bb" ? 1 : 2,
          )} />
          <Metric label="Diamond Score" value={row.diamond_score != null ? Math.round(row.diamond_score).toString() : "—"} />
        </div>
        {row.projected_pa != null || row.projected_bf != null ? (
          <div className="mono mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
            {role === "hitter" ? `${num(row.projected_pa, 1)} projected PA` : `${num(row.projected_bf, 0)} projected BF`}
          </div>
        ) : null}
      </Section>

      {/* Alpha vs Calibrated */}
      <Section title="Alpha · Calibration">
        {loading ? <Skeleton /> : (() => {
          const raw = detail?.calibration.alpha_raw_probability ?? null;
          const cal = detail?.calibration.calibrated_probability ?? null;
          const ver = detail?.calibration.calibration_version ?? null;
          if (raw == null && cal == null) {
            return <p className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Not stored in this snapshot.</p>;
          }
          return (
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Alpha raw probability" value={pct(raw)} />
              <Metric
                label={`Calibrated probability${ver ? ` · ${ver}` : (raw != null && cal == null ? " · uncalibrated" : "")}`}
                value={pct(cal)}
              />
            </div>
          );
        })()}
      </Section>

      {/* Monte Carlo distributions */}
      <Section title="Monte Carlo distribution">
        {loading ? <Skeleton /> : detail && Object.keys(detail.distributions).length ? (
          <div className="space-y-1.5">
            <div className="mono grid grid-cols-[1fr_56px_56px_56px_56px] gap-2 text-[10px] uppercase tracking-widest text-muted-foreground">
              <span>Stat</span><span className="text-right">Mean</span><span className="text-right">P50</span><span className="text-right">P90</span><span className="text-right">≥1</span>
            </div>
            {Object.entries(detail.distributions).map(([k, d]) => (
              <div key={k} className="mono grid grid-cols-[1fr_56px_56px_56px_56px] gap-2 text-xs tabular-nums">
                <span className="uppercase tracking-widest text-foreground/80">{k}</span>
                <span className="text-right">{num(d.mean, 2)}</span>
                <span className="text-right">{num(d.p50, 2)}</span>
                <span className="text-right">{num(d.p90, 2)}</span>
                <span className="text-right">{pct(d.probAtLeast1)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mono text-[10px] uppercase tracking-widest text-muted-foreground">No simulation snapshot persisted.</p>
        )}
      </Section>

      {/* Diamond Score breakdown */}
      <Section title="Diamond Score breakdown">
        {role === "hitter" ? (
          <div className="grid grid-cols-5 gap-2">
            <Mini label="Contact" v={detail?.diamond.contact ?? row.contact_score} />
            <Mini label="Power"   v={detail?.diamond.power ?? row.power_score} />
            <Mini label="Speed"   v={detail?.diamond.speed ?? row.speed_score} />
            <Mini label="vs SP"   v={detail?.diamond.pitcher_grade ?? row.pitcher_grade} />
            <Mini label="Matchup" v={detail?.diamond.matchup_grade ?? row.matchup_grade} />
          </div>
        ) : (
          <div className="space-y-1">
            {(detail?.diamond.pitcher_components ?? row.pitcher_components ?? []).length === 0 ? (
              <p className="mono text-[10px] uppercase tracking-widest text-muted-foreground">No components persisted.</p>
            ) : (detail?.diamond.pitcher_components ?? row.pitcher_components).map((c: any) => (
              <div key={c.key} className="mono grid grid-cols-[1fr_48px_48px] items-baseline gap-2 text-xs tabular-nums">
                <span className="text-foreground/80">{c.label}</span>
                <span className="text-right">{Math.round(c.value)}</span>
                <span className="text-right text-muted-foreground">×{c.weight.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Why Diamond likes it */}
      {(detail?.narrative ?? row.inputs_narrative) ? (
        <Section title="Why Diamond likes it">
          <p className="text-xs leading-relaxed text-foreground/80">{detail?.narrative ?? row.inputs_narrative}</p>
        </Section>
      ) : null}

      {/* Game context */}
      <Section title="Game context">
        <div className="mono grid grid-cols-2 gap-2 text-[11px] uppercase tracking-widest text-muted-foreground">
          {detail?.game.venue ? <span>Venue · <span className="text-foreground/80">{detail.game.venue}</span></span> : null}
          {detail?.context.opponent_starter_name ? <span>Opp SP · <span className="text-foreground/80">{detail.context.opponent_starter_name}</span></span> : null}
          {detail?.context.park_factor != null ? <span>Park factor · <span className="text-foreground/80">{num(detail.context.park_factor, 2)}</span></span> : null}
          {detail?.context.weather ? <span>Weather · <span className="text-foreground/80">{detail.context.weather}</span></span> : null}
          {detail?.forecast.locked_at ? <span>Locked · <span className="text-foreground/80">{formatTimeInAppTz(detail.forecast.locked_at)}</span></span> : null}
          {detail?.forecast.published_at ? <span>Published · <span className="text-foreground/80">{formatTimeInAppTz(detail.forecast.published_at)}</span></span> : null}
          <span>Model · <span className="text-foreground/80">{row.model_version}</span></span>
        </div>
      </Section>

      {/* Live / final actuals */}
      {(detail?.actual ?? row.actual) ? (
        <Section title="Actuals">
          <p className="mono text-xs uppercase tracking-widest text-foreground">
            {formatActual(detail?.actual ?? row.actual, market) || "—"}
          </p>
          <ActualBoxScore a={detail?.actual ?? row.actual} role={role} />
        </Section>
      ) : null}

      {/* Deep link */}
      {row.mlb_id != null ? (
        <div className="border-t border-border/50 px-1 py-4">
          <Link
            to="/players/$playerId" params={{ playerId: String(row.mlb_id) }}
            className="mono text-[11px] uppercase tracking-widest text-primary hover:underline"
          >View full player page →</Link>
          {row.mlb_game_id ? (
            <Link
              to="/matchups/$gamePk" params={{ gamePk: String(row.mlb_game_id) }}
              className="mono ml-4 text-[11px] uppercase tracking-widest text-edge hover:underline"
            >Open matchup →</Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border/40 px-1 py-4">
      <h3 className="mono mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/50 bg-secondary/30 px-2.5 py-2">
      <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mono mt-0.5 text-lg font-bold tabular-nums text-foreground">{value}</div>
    </div>
  );
}
function Mini({ label, v }: { label: string; v: number | null | undefined }) {
  return (
    <div className="rounded-md border border-border/40 bg-card/40 px-1 py-1 text-center">
      <div className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mono text-sm font-semibold tabular-nums text-foreground">{v != null ? Math.round(v) : "—"}</div>
    </div>
  );
}
function Skeleton() {
  return <div className="h-12 animate-pulse rounded bg-secondary/40" />;
}
function ActualBoxScore({ a, role }: { a: any; role: "hitter" | "pitcher" }) {
  if (!a) return null;
  if (role === "hitter") {
    return (
      <div className="mono mt-2 grid grid-cols-4 gap-2 text-[11px] uppercase tracking-widest text-muted-foreground">
        <span>H · <span className="text-foreground/80">{a.hits ?? "—"}</span></span>
        <span>HR · <span className="text-foreground/80">{a.home_runs ?? "—"}</span></span>
        <span>TB · <span className="text-foreground/80">{a.total_bases ?? "—"}</span></span>
        <span>RBI · <span className="text-foreground/80">{a.rbis ?? "—"}</span></span>
        <span>SB · <span className="text-foreground/80">{a.stolen_bases ?? "—"}</span></span>
        <span>BB · <span className="text-foreground/80">{a.walks ?? "—"}</span></span>
        <span>K · <span className="text-foreground/80">{a.strikeouts ?? "—"}</span></span>
        <span>R · <span className="text-foreground/80">{a.runs ?? "—"}</span></span>
      </div>
    );
  }
  return (
    <div className="mono mt-2 grid grid-cols-3 gap-2 text-[11px] uppercase tracking-widest text-muted-foreground">
      <span>K · <span className="text-foreground/80">{a.strikeouts ?? "—"}</span></span>
      <span>BB · <span className="text-foreground/80">{a.walks ?? "—"}</span></span>
      <span>H · <span className="text-foreground/80">{a.hits ?? "—"}</span></span>
    </div>
  );
}
