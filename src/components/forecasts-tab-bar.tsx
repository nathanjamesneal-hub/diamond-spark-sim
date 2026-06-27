/**
 * ForecastsTabBar — page-level tab nav for the Forecasts hub.
 * Each tab is a real route, so deep links and refreshes still work.
 */
import { Link, useRouterState } from "@tanstack/react-router";

const TABS = [
  { to: "/diamond-scores", label: "Board" },
  { to: "/slate", label: "All Forecasts" },
  { to: "/odds", label: "Rankings" },
  { to: "/diamond-consensus", label: "Consensus" },
  { to: "/top-props", label: "Top Props" },
  { to: "/leaderboards", label: "Player Search" },
] as const;

export function ForecastsTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="mx-auto mb-4 max-w-7xl px-4 md:px-6">
      <div className="mono mb-1 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        Forecasts
      </div>
      <nav className="flex items-center gap-1 overflow-x-auto border-b border-border/60">
        {TABS.map((t) => {
          const active = pathname === t.to;
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
