import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

function DefaultErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  const e = error as { name?: string; message?: string; stack?: string } | null | undefined;
  const message = e?.message ?? String(error ?? "Unknown error");
  if (typeof console !== "undefined") console.error("[router defaultErrorComponent]", error);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-xl font-semibold tracking-tight text-foreground">
          Rain delay.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong. Try again or head home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              try { reset(); } catch {}
              if (typeof window !== "undefined") window.location.reload();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
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

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorComponent,
  });

  return router;
};
