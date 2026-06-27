import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ForecastsTabBar } from "@/components/forecasts-tab-bar";
import { LabTabBar } from "@/components/projection-lab/lab-tab-bar";

/** /forecasts/lab layout — renders the Forecasts hub tab bar, then the Lab
 *  sub-tab bar, then the active Lab page via <Outlet/>. */
export const Route = createFileRoute("/_authenticated/forecasts/lab")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Projection Lab · Diamond" },
      {
        name: "description",
        content:
          "Read-only view of persisted Monte Carlo means, Alpha probabilities, and the active Diamond engine version.",
      },
    ],
  }),
  component: LabLayout,
});

function LabLayout() {
  return (
    <div className="py-6">
      <ForecastsTabBar />
      <div className="mx-auto mb-2 max-w-7xl px-4 md:px-6">
        <h1 className="font-display text-3xl tracking-tight">Projection Lab</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Persisted forecast snapshots only — this view never re-runs the
          simulator. Numbers are exactly what was published or locked.
        </p>
      </div>
      <LabTabBar />
      <Outlet />
    </div>
  );
}
