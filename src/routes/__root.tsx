import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { SiteHeader } from "@/components/site-header";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Foul ball.</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          That page is out of the park. Let's get you back to the dugout.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Back to today
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  const e = (error ?? {}) as { name?: string; message?: string; stack?: string };
  const message = e.message ?? String(error ?? "Unknown error");
  if (typeof console !== "undefined") console.error(error);
  const router = useRouter();
  useEffect(() => {
    try {
      reportLovableError(error, { boundary: "tanstack_root_error_component" });
    } catch {}
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-xl font-semibold tracking-tight text-foreground">
          Rain delay.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong loading this page. Try again or head home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              try { router.invalidate(); } catch {}
              try { reset(); } catch {}
              if (typeof window !== "undefined") window.location.reload();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
        <details className="mt-6 text-left">
          <summary className="cursor-pointer text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
            Error details
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border/60 bg-card p-3 text-[11px] leading-snug text-muted-foreground whitespace-pre-wrap break-words">
            {e?.name ? `${e.name}: ` : ""}{message}
            {e?.stack ? `\n\n${e.stack}` : ""}
          </pre>
        </details>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Diamond — MLB simulation & projection engine" },
      {
        name: "description",
        content:
          "Built for baseball. Monte Carlo simulations, daily projections, and calibration intelligence for every MLB game.",
      },
      { name: "author", content: "Diamond" },
      { property: "og:title", content: "Diamond — Built for baseball" },
      {
        property: "og:description",
        content:
          "MLB simulation & projection engine. Mean projections, prediction drivers, and model calibration.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <div className="relative z-10 flex min-h-screen flex-col">
        <SiteHeader />
        <main className="flex-1">
          <Outlet />
        </main>
        <footer className="border-t border-border/60 px-4 py-6 text-center text-xs text-muted-foreground">
          Data from MLB Stats API · Not affiliated with MLB · For entertainment only
        </footer>
      </div>
    </QueryClientProvider>
  );
}
