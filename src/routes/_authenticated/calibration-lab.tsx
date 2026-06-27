import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/calibration-lab")({
  beforeLoad: () => { throw redirect({ to: "/model" }); },
});
