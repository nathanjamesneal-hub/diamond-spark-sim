import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getFeaturedRuns, buildLiveRecommendationsNow, type FeaturedLeg, type FeaturedRun } from "@/lib/recommendations/featured.functions";

const runsQuery = () =>
  queryOptions({
    queryKey: ["featured-runs"],
    queryFn: () => getFeaturedRuns({ data: {} }),
    refetchInterval: 60_000,
  });

export const Route = createFileRoute("/_authenticated/featured")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Featured Diamond · Best Bets & Tickets" },
      { name: "description", content: "Diamond's highest-conviction player props and cross-game tickets for today's slate." },
    ],
  }),
  component: FeaturedPage,
});

function FeaturedPage() {
  const [view, setView] = useState<"LIVE" | "OFFICIAL">("LIVE");
  const { data, isLoading, refetch } = useQuery(runsQuery());
  const buildLive = useServerFn(buildLiveRecommendationsNow);
  const rebuild = useMutation({
    mutationFn: () => buildLive({ data: {} }),
    onSettled: () => refetch(),
  });

  const run: FeaturedRun | undefined = view === "LIVE" ? data?.live : data?.official;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Featured Diamond</h1>
          <p className="text-sm text-muted-foreground">
            {view === "LIVE"
              ? "Live picks from the newest completed projections. Updates as inputs change."
              : "Official picks from the immutable pregame snapshot. Never changes after first pitch."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-md border p-0.5 flex text-xs">
            <button
              className={`px-3 py-1 rounded ${view === "LIVE" ? "bg-primary text-primary-foreground" : ""}`}
              onClick={() => setView("LIVE")}
            >LIVE</button>
            <button
              className={`px-3 py-1 rounded ${view === "OFFICIAL" ? "bg-primary text-primary-foreground" : ""}`}
              onClick={() => setView("OFFICIAL")}
            >OFFICIAL</button>
          </div>
          {view === "LIVE" && (
            <Button size="sm" variant="outline" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
              {rebuild.isPending ? "Rebuilding…" : "Rebuild now"}
            </Button>
          )}
        </div>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && run && <RunView run={run} />}
    </div>
  );
}

function RunView({ run }: { run: FeaturedRun }) {
  const hasQualifying = run.bestBet != null || run.featured.length > 0;
  return (
    <div className="space-y-6">
      <RunMeta run={run} />

      {!hasQualifying && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            <strong>No Qualified Ticket.</strong> No prop meets today's probability, edge, and certainty thresholds.
            {run.unvalidatedPreview.length > 0 && (
              <span> {run.unvalidatedPreview.length} candidate(s) available in the Preview / unvalidated tier below.</span>
            )}
          </CardContent>
        </Card>
      )}

      {run.bestBet && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">Best Bet</h2>
          <LegCard leg={run.bestBet} highlight />
        </section>
      )}

      {run.featured.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">Featured Plays</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {run.featured.map((leg) => <LegCard key={leg.id} leg={leg} />)}
          </div>
        </section>
      )}

      {run.tickets.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">Tickets</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {run.tickets.map((t) => (
              <Card key={t.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    Diamond {t.kind === "double" ? "Double" : t.kind === "triple" ? "Triple" : "Higher-Upside"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-1">
                  <div>Legs: {t.legIds.length}</div>
                  <div>Est. combined probability: {t.estimatedCombinedProbability != null ? `${(t.estimatedCombinedProbability * 100).toFixed(1)}%` : "—"}</div>
                  <div className="text-xs text-muted-foreground">
                    Min leg prob {t.minLegProbability != null ? `${(t.minLegProbability * 100).toFixed(0)}%` : "—"} · min score {t.minRecommendationScore ?? "—"}
                  </div>
                  <p className="text-xs text-muted-foreground pt-1">
                    Estimated combined probability assumes independence across accepted cross-game legs.
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {run.unvalidatedPreview.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Preview / unvalidated
          </h2>
          <p className="text-xs text-muted-foreground mb-2">
            The engine is currently scaffold/unvalidated. These candidates are shown for preview only — they are excluded from official grading and cannot be added to tickets.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {run.unvalidatedPreview.slice(0, 6).map((leg) => <LegCard key={leg.id} leg={leg} muted />)}
          </div>
        </section>
      )}

      {run.rejected.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Rejected candidates ({run.rejected.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {run.rejected.slice(0, 25).map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span className="font-mono">{r.playerName ?? r.playerId}</span>
                <span className="text-muted-foreground">{r.market}/{r.side}</span>
                <Badge variant="outline">{r.rejectReason}</Badge>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function RunMeta({ run }: { run: FeaturedRun }) {
  return (
    <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
      <span>State: <strong>{run.state ?? "—"}</strong></span>
      <span>Slate: {run.slateDate}</span>
      <span>Generated: {run.generatedAt ? new Date(run.generatedAt).toLocaleString() : "—"}</span>
      <span>Model: {run.modelVersion ?? "—"}</span>
      <span>Formula: {run.formulaVersion ?? "—"}</span>
      <span>Pool: {run.candidatePoolSize}</span>
    </div>
  );
}

function LegCard({ leg, highlight, muted }: { leg: FeaturedLeg; highlight?: boolean; muted?: boolean }) {
  const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
  const pp = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}pp`);
  return (
    <Card className={highlight ? "border-primary" : muted ? "opacity-70" : undefined}>
      <CardHeader className="pb-1">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base leading-snug">
            {leg.playerName ?? leg.playerId}
            {leg.gameLabel && <span className="ml-2 text-xs text-muted-foreground">{leg.gameLabel}</span>}
          </CardTitle>
          <Badge variant="secondary">{leg.recommendationScore?.toFixed(1) ?? "—"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="text-sm space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="font-medium">
            {leg.side.toUpperCase()} {leg.line != null ? leg.line : ""} {leg.market}
          </span>
          {leg.price != null && <span className="text-xs">@ {leg.price > 0 ? `+${leg.price}` : leg.price}</span>}
        </div>
        <div className="text-xs grid grid-cols-3 gap-1">
          <div>Diamond {pct(leg.diamondProbability)}</div>
          <div>No-vig {pct(leg.novigProbability)}</div>
          <div>Edge {pp(leg.edgePp)}</div>
        </div>
        <div className="flex flex-wrap gap-1 text-[10px]">
          {leg.projectionStage && <Badge variant="outline">{leg.projectionStage}</Badge>}
          {leg.form?.direction && <Badge variant="outline">Form: {leg.form.direction}</Badge>}
          {leg.engineStatus && <Badge variant={leg.engineStatus.includes("scaffold") ? "destructive" : "outline"}>{leg.engineStatus}</Badge>}
        </div>
        {leg.why?.breakdown && (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">Why Diamond likes it</summary>
            <ul className="pl-4 pt-1">
              <li>Probability weight: {(leg.why.breakdown.probability * 100).toFixed(0)}%</li>
              <li>Edge weight: {(leg.why.breakdown.edge * 100).toFixed(0)}%</li>
              <li>Certainty: {(leg.why.breakdown.certainty * 100).toFixed(0)}%</li>
              <li>Form: {(leg.why.breakdown.form * 100).toFixed(0)}%</li>
              <li>Matchup: {(leg.why.breakdown.matchup * 100).toFixed(0)}%</li>
              {leg.why.probabilityOnly && <li className="text-amber-600">Probability-only (no market price)</li>}
            </ul>
          </details>
        )}
        {leg.uncertainty && (leg.uncertainty.sim_count || leg.uncertainty.stderr) && (
          <div className="text-[10px] text-muted-foreground">
            {leg.uncertainty.sim_count ? `${leg.uncertainty.sim_count.toLocaleString()} sims` : ""}
            {leg.uncertainty.stderr != null ? ` · stderr ${leg.uncertainty.stderr.toFixed(2)}` : ""}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
