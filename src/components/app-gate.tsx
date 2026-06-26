import { useEffect, useState, type ReactNode } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

const PUBLIC_PATHS = new Set(["/auth", "/reset-password"]);

type Status = "loading" | "allowed" | "blocked";

export function AppGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let cancelled = false;

    async function evaluate() {
      const isPublic = PUBLIC_PATHS.has(pathname);
      const { data: userData } = await supabase.auth.getUser();
      const user = userData?.user ?? null;

      if (!user) {
        if (isPublic) {
          if (!cancelled) setStatus("allowed");
        } else {
          if (!cancelled) setStatus("blocked");
          router.navigate({ to: "/auth" });
        }
        return;
      }

      // Signed in — check membership
      const { data: isMember, error } = await supabase.rpc("is_app_member");
      if (cancelled) return;
      if (error || !isMember) {
        await supabase.auth.signOut();
        if (!cancelled) {
          setStatus("blocked");
          router.navigate({ to: "/auth" });
        }
        return;
      }
      if (!cancelled) setStatus("allowed");
    }

    setStatus("loading");
    evaluate();

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        evaluate();
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [pathname, router]);

  if (status === "loading" || status === "blocked") {
    if (PUBLIC_PATHS.has(pathname) && status !== "loading") return <>{children}</>;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
          {status === "blocked" ? "Redirecting…" : "Loading…"}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
