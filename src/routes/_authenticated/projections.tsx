import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/projections")({
  beforeLoad: () => { throw redirect({ to: "/slate" }); },
});
