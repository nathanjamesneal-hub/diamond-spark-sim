import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";

const nav = [
  { to: "/", label: "Today" },
  { to: "/scores", label: "Scores" },
  { to: "/odds", label: "Odds" },
  { to: "/standings", label: "Standings" },
  { to: "/slate", label: "Projections" },
  { to: "/diamond-scores", label: "Diamond" },
  { to: "/lineup-status", label: "Pipeline" },
  { to: "/calibration", label: "Calibration" },
  { to: "/leaderboards", label: "Leaders" },
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
    <header className="relative z-10 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-6">
        <Link to="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <span className="font-display text-lg font-bold">◆</span>
          </div>
          <div className="flex flex-col leading-none">
            <span className="font-display text-lg font-bold tracking-wider text-foreground">DIAMOND</span>
            <span className="mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              forecasting · versioned · calibrated
            </span>
          </div>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {nav.map((item) => (
            <Link key={item.to} to={item.to}
              activeOptions={{ exact: item.to === "/" }}
              activeProps={{ className: "bg-secondary text-foreground" }}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
          {isAdmin ? (
            <Link to="/admin"
              activeProps={{ className: "bg-secondary text-foreground" }}
              className="mono rounded-md px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-edge transition-colors hover:bg-secondary"
            >
              Admin
            </Link>
          ) : null}
        </nav>

        <div className="flex items-center gap-2">
          {user ? (
            <button onClick={signOut}
              className="mono rounded-md border border-border/60 px-2.5 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
              Sign out
            </button>
          ) : (
            <Link to="/auth"
              className="mono rounded-md bg-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-primary-foreground hover:bg-primary/90">
              Sign in
            </Link>
          )}
        </div>
      </div>

      <nav className="flex items-center gap-1 overflow-x-auto border-t border-border/40 px-4 py-2 md:hidden">
        {nav.map((item) => (
          <Link key={item.to} to={item.to}
            activeOptions={{ exact: item.to === "/" }}
            activeProps={{ className: "bg-secondary text-foreground" }}
            className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {item.label}
          </Link>
        ))}
        {isAdmin ? (
          <Link to="/admin" className="mono whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-edge">
            Admin
          </Link>
        ) : null}
      </nav>
    </header>
  );
}
