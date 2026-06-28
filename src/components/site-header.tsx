import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";

const nav = [
  { to: "/", label: "Today" },
  { to: "/today/live", label: "Live" },
  { to: "/forecasts", label: "Forecasts" },
  { to: "/results", label: "Results" },
  { to: "/model", label: "Model" },
] as const;

export function SiteHeader() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    try {
      supabase.auth
        .getUser()
        .then(({ data }) => {
          if (active) setUser(data.user ?? null);
        })
        .catch((e) => console.warn("[site-header] getUser failed", e));
    } catch (e) {
      console.warn("[site-header] getUser threw", e);
    }

    let unsub: (() => void) | undefined;
    try {
      const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
        if (active) setUser(session?.user ?? null);
      });
      unsub = () => sub.subscription.unsubscribe();
    } catch (e) {
      console.warn("[site-header] onAuthStateChange failed", e);
    }
    return () => {
      active = false;
      try { unsub?.(); } catch {}
    };
  }, []);

  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    let active = true;
    Promise.resolve(supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }))
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          console.warn("[site-header] has_role failed", error);
          setIsAdmin(false);
          return;
        }
        setIsAdmin(!!data);
      })
      .catch((e: unknown) => {
        console.warn("[site-header] has_role threw", e);
        if (active) setIsAdmin(false);
      });
    return () => { active = false; };
  }, [user]);

  async function signOut() {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn("[site-header] signOut failed", e);
    }
    try {
      navigate({ to: "/" });
    } catch {
      if (typeof window !== "undefined") window.location.href = "/";
    }
  }

  return (
    <header className="relative z-10 border-b border-border bg-[var(--color-surface-panel)]/95 backdrop-blur shadow-[0_1px_0_rgb(255_255_255/0.04)_inset]">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 md:px-6">
        <Link to="/" className="flex items-center gap-3">
          <div className="glow-edge flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-primary">
            <span className="text-xl leading-none">◆</span>
          </div>
          <div className="flex flex-col leading-none">
            <span className="wordmark text-2xl text-foreground">Diamond</span>
            <span className="mono mt-1 text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
              MLB Simulation &amp; Projection Engine
            </span>
          </div>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {nav.map((item) => (
            <Link key={item.to} to={item.to}
              activeOptions={{ exact: item.to === "/" }}
              activeProps={{ className: "text-foreground border-primary" }}
              className="border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
          {isAdmin ? (
            <>
              <Link to="/admin"
                activeProps={{ className: "text-foreground border-primary" }}
                className="mono border-b-2 border-transparent px-3 py-2 text-xs font-bold uppercase tracking-widest text-primary transition-colors hover:text-foreground"
              >
                Admin
              </Link>
              <Link to="/petri"
                activeProps={{ className: "text-foreground border-amber-400" }}
                className="mono border-b-2 border-transparent px-3 py-2 text-xs font-bold uppercase tracking-widest text-amber-400 transition-colors hover:text-foreground"
              >
                Petri
              </Link>
            </>
          ) : null}
        </nav>

        <div className="flex items-center gap-2">
          {user ? (
            <button onClick={signOut}
              className="mono rounded-md border border-border px-2.5 py-1 text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground">
              Sign out
            </button>
          ) : (
            <Link to="/auth"
              className="mono rounded-md bg-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-primary-foreground transition-colors hover:bg-primary/90">
              Sign in
            </Link>
          )}
        </div>
      </div>

      <nav className="flex items-center gap-1 overflow-x-auto border-t border-border/60 px-4 py-2 md:hidden">
        {nav.map((item) => (
          <Link key={item.to} to={item.to}
            activeOptions={{ exact: item.to === "/" }}
            activeProps={{ className: "text-foreground border-primary" }}
            className="whitespace-nowrap border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {item.label}
          </Link>
        ))}
        {isAdmin ? (
          <>
            <Link to="/admin" className="mono whitespace-nowrap border-b-2 border-transparent px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-primary">
              Admin
            </Link>
            <Link to="/petri" className="mono whitespace-nowrap border-b-2 border-transparent px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-amber-400">
              Petri
            </Link>
          </>
        ) : null}
      </nav>
    </header>
  );
}
