import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/leaders")({
  beforeLoad: () => { throw redirect({ to: "/leaderboards" }); },
});
