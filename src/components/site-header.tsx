import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";
import { DiamondMark } from "@/components/brand/diamond-mark";

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
    <header className="relative z-10 border-b border-[color-mix(in_oklab,var(--brass)_15%,var(--border))] bg-[color-mix(in_oklab,var(--ink)_88%,transparent)] backdrop-blur-xl">
      {/* Masthead */}
      <div className="mx-auto max-w-7xl px-4 pt-5 pb-3 md:px-6">
        <div className="flex items-start justify-between gap-4">
          <Link to="/" className="group flex items-center gap-3 leading-none">
            <span
              aria-hidden
              className="relative flex h-9 w-9 items-center justify-center rounded-md border border-[color-mix(in_oklab,var(--brass)_45%,transparent)] bg-[color-mix(in_oklab,var(--brass)_10%,var(--ink))] shadow-[0_0_18px_color-mix(in_oklab,var(--brass)_35%,transparent)]"
            >
              <span className="block h-3.5 w-3.5 rotate-45 border border-[var(--brass)] bg-[color-mix(in_oklab,var(--brass)_25%,transparent)] shadow-[0_0_10px_color-mix(in_oklab,var(--brass)_65%,transparent)]" />
            </span>
            <span className="flex flex-col leading-none">
              <span className="wordmark bg-gradient-to-r from-[var(--cream)] via-[var(--primary-glow)] to-[var(--brass)] bg-clip-text text-3xl text-transparent md:text-4xl">
                Diamond
              </span>
              <span className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--primary)]">
                Live MLB Intelligence
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-2 pt-1">
            {user ? (
              <button onClick={signOut}
                className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--warm-muted)] transition-colors hover:border-[color-mix(in_oklab,var(--brass)_55%,var(--border))] hover:text-[var(--cream)]">
                Sign out
              </button>
            ) : (
              <Link to="/auth"
                className="rounded-md border border-[color-mix(in_oklab,var(--brass)_50%,transparent)] bg-[color-mix(in_oklab,var(--brass)_18%,transparent)] px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-[var(--cream)] shadow-[0_0_14px_color-mix(in_oklab,var(--brass)_35%,transparent)] transition-all hover:brightness-125">
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
