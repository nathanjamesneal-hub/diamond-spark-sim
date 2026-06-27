import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/model-results")({
  beforeLoad: () => { throw redirect({ to: "/model" }); },
});
