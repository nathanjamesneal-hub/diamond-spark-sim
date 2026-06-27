import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/sim-leaders")({
  beforeLoad: () => { throw redirect({ to: "/odds" }); },
});
