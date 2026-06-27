/** Lab sub-tab bar — three internal tabs inside Projection Lab. */
import { Link, useRouterState } from "@tanstack/react-router";

const TABS = [
  { to: "/forecasts/lab", label: "Engine Status", match: "exact" as const },
  { to: "/forecasts/lab/means", label: "Simulation Means", match: "exact" as const },
  { to: "/forecasts/lab/alpha", label: "Alpha vs Diamond", match: "exact" as const },
];

export function LabTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="mx-auto mb-6 flex max-w-7xl items-center gap-1 overflow-x-auto border-b border-border/60 px-4 md:px-6">
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
  );
}
