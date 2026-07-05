import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";

const nav = [
  { to: "/", label: "Live" },
  { to: "/hitters", label: "Hitters" },
  { to: "/pitchers", label: "Pitchers" },
  { to: "/mlb-pulse", label: "Pulse" },
  { to: "/watchlist", label: "Watchlist" },
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
        if (error) { setIsAdmin(false); return; }
        setIsAdmin(!!data);
      })
      .catch(() => { if (active) setIsAdmin(false); });
    return () => { active = false; };
  }, [user]);

  async function signOut() {
    try { await supabase.auth.signOut(); } catch {}
    try { navigate({ to: "/" }); } catch {
      if (typeof window !== "undefined") window.location.href = "/";
    }
  }

  return (
    <header className="relative z-10 border-b border-[var(--border)] bg-[var(--color-background)]/95 backdrop-blur">
      {/* Masthead */}
      <div className="mx-auto max-w-7xl px-4 pt-5 pb-3 md:px-6">
        <div className="flex items-start justify-between gap-4">
          <Link to="/" className="group flex flex-col leading-none">
            <span className="wordmark text-4xl md:text-5xl text-[var(--cream)] tracking-[0.08em]">
              Diamond
            </span>
            <span className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--primary)]">
              MLB Risers, Fallers &amp; Live Intelligence
            </span>
          </Link>
          <div className="flex items-center gap-2 pt-1">
            {user ? (
              <button onClick={signOut}
                className="rounded-sm border border-[var(--border)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--warm-muted)] transition-colors hover:text-[var(--cream)]">
                Sign out
              </button>
            ) : (
              <Link to="/auth"
                className="rounded-sm bg-[var(--field)] px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-[var(--cream)] transition-colors hover:brightness-110">
                Sign in
              </Link>
            )}
          </div>
        </div>

        <div className="masthead-rule mt-4" />
      </div>

      {/* Primary nav — publication tab bar */}
      <nav className="mx-auto flex max-w-7xl items-center gap-0 overflow-x-auto px-4 pb-2 md:px-6">
        {nav.map((item) => (
          <Link key={item.to} to={item.to}
            activeOptions={{ exact: item.to === "/" }}
            activeProps={{
              className:
                "text-[var(--cream)] border-[var(--primary)]",
            }}
            className="whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--warm-muted)] transition-colors hover:text-[var(--cream)]"
          >
            {item.label}
          </Link>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Link to="/lab"
            activeProps={{ className: "text-[var(--cream)] border-[var(--primary)]" }}
            className="whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--warm-muted)] transition-colors hover:text-[var(--cream)]"
          >
            Lab
          </Link>
          {isAdmin ? (
            <>
              <Link to="/admin"
                activeProps={{ className: "text-[var(--cream)] border-[var(--primary)]" }}
                className="whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--primary)] transition-colors hover:text-[var(--cream)]"
              >
                Admin
              </Link>
              <Link to="/petri"
                activeProps={{ className: "text-[var(--cream)] border-[var(--primary)]" }}
                className="whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--primary)] transition-colors hover:text-[var(--cream)]"
              >
                Petri
              </Link>
            </>
          ) : null}
        </div>
      </nav>
    </header>
  );
}
