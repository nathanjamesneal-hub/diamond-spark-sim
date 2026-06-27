import { createFileRoute, Outlet } from "@tanstack/react-router";

/** /forecasts hub layout. The bare /forecasts path is handled by
 *  forecasts.index.tsx (redirects to the Board tab). Child routes such as
 *  /forecasts/lab render via this Outlet so the redirect does not swallow
 *  nested URLs. */
export const Route = createFileRoute("/_authenticated/forecasts")({
  component: () => <Outlet />,
});
