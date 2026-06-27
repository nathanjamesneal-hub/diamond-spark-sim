import { createFileRoute, redirect } from "@tanstack/react-router";

/** /forecasts hub — defaults to the Board tab. */
export const Route = createFileRoute("/_authenticated/forecasts")({
  beforeLoad: () => {
    throw redirect({ to: "/diamond-scores" });
  },
});
