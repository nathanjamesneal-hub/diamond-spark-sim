import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/lab")({
  head: () => ({
    meta: [
      { title: "Lab — Model Research" },
      { name: "description", content: "Diamond simulation and forecasting research surfaces." },
    ],
  }),
  component: LabPage,
});

const links: Array<{ to: string; title: string; desc: string }> = [
  { to: "/forecasts", title: "Forecasts", desc: "Alpha model per-game forecasts and consensus." },
  { to: "/results", title: "Results", desc: "Historical forecast vs actual outcome tracking." },
  { to: "/model", title: "Model", desc: "Model version registry and metadata." },
  { to: "/model-results", title: "Model Results", desc: "Backtests and per-run outputs." },
  { to: "/projections", title: "Projections", desc: "Player projection outputs." },
  { to: "/leaders", title: "Leaders", desc: "Projection-based leaderboards." },
  { to: "/sim-leaders", title: "Sim Leaders", desc: "Monte Carlo simulation leaderboards." },
  { to: "/diamond-scores", title: "Diamond Scores", desc: "Legacy Diamond Score surface." },
  { to: "/diamond-consensus", title: "Diamond Consensus", desc: "Consensus projections." },
  { to: "/leaderboards", title: "Leaderboards", desc: "General leaderboards." },
  { to: "/calibration", title: "Calibration", desc: "Model calibration reports." },
  { to: "/calibration-lab", title: "Calibration Lab", desc: "Calibration research." },
  { to: "/odds", title: "Odds", desc: "Odds comparison surface." },
  { to: "/top-props", title: "Top Props", desc: "Prop screening surface." },
  { to: "/bets", title: "Bets", desc: "Recorded bets." },
  { to: "/scores", title: "Scores", desc: "Live scoreboard." },
  { to: "/today/live", title: "Live", desc: "Legacy live surface." },
  { to: "/slate", title: "Slate", desc: "Daily slate view." },
  { to: "/standings", title: "Standings", desc: "MLB standings." },
  { to: "/lineup-status", title: "Lineup Status", desc: "Lineup pipeline health." },
];

function LabPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-10">
      <div className="eyebrow text-[var(--primary)]">Diamond · Secondary</div>
      <h1 className="mt-1 text-[32px] leading-tight text-[var(--cream)] md:text-[44px]">
        Lab
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-[var(--warm-muted)]">
        Research surfaces — simulations, forecasts, calibration, back-tests. These sit behind Diamond Live
        and are for exploration only.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className="block rounded-sm border border-[var(--border)] bg-[color-mix(in_oklab,var(--charcoal)_85%,transparent)] px-3 py-2.5 transition-colors hover:border-[var(--brass)]"
          >
            <div className="text-sm font-semibold text-[var(--cream)]">{l.title}</div>
            <div className="mt-0.5 text-[11px] text-[var(--warm-muted)]">{l.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

