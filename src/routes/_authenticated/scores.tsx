import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/scores")({
  beforeLoad: () => {
    throw redirect({ to: "/today/live" });
  },
  component: () => null,
});
