import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

const PUBLIC_PATHS = new Set(["/auth", "/reset-password"]);

type Status = "loading" | "allowed" | "blocked";

export function AppGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [status, setStatus] = useState<Status>("loading");
  const evalSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const isPublic = PUBLIC_PATHS.has(pathname);

    async function checkMembership(retry = true): Promise<boolean | null> {
      const { data, error } = await supabase.rpc("is_app_member");
      if (error) {
        // Transient/network error — retry once, then keep loading rather than sign out.
        if (retry) {
          await new Promise((r) => setTimeout(r, 600));
          return checkMembership(false);
        }
        return null; // unknown — do NOT sign out
      }
      return !!data;
    }

    async function evaluate() {
      const seq = ++evalSeq.current;
      const { data: userData } = await supabase.auth.getUser();
      if (cancelled || seq !== evalSeq.current) return;
      const user = userData?.user ?? null;

      if (!user) {
        if (isPublic) {
          setStatus("allowed");
        } else {
          setStatus("blocked");
          router.navigate({ to: "/auth" });
        }
        return;
      }

      const member = await checkMembership();
      if (cancelled || seq !== evalSeq.current) return;

      if (member === null) {
        // Don't flip to blocked or sign out on transport errors; stay loading.
        return;
      }
      if (!member) {
        await supabase.auth.signOut();
        if (cancelled || seq !== evalSeq.current) return;
        setStatus("blocked");
        router.navigate({ to: "/auth" });
        return;
      }
      setStatus("allowed");
    }

    // Subscribe FIRST so we don't miss a SIGNED_IN that fires while getUser() is in flight.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (
        event === "SIGNED_IN" ||
        event === "SIGNED_OUT" ||
        event === "USER_UPDATED" ||
        event === "INITIAL_SESSION" ||
        event === "TOKEN_REFRESHED"
      ) {
        evaluate();
      }
    });

    setStatus("loading");
    evaluate();

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [pathname, router]);

  if (status === "allowed") return <>{children}</>;
  if (status === "blocked" && PUBLIC_PATHS.has(pathname)) return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
        {status === "blocked" ? "Redirecting…" : "Loading…"}
      </div>
    </div>
  );
}
