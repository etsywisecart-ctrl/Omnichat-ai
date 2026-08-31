"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { NAV_ITEMS, THEME_ICON } from "@/lib/data";
import type { PageId } from "@/lib/types";
import { useDashboardStore, isDark, mapConvStatus } from "@/store/useDashboardStore";
import { useSession } from "@/hooks/useSession";
import { useTeamMembers } from "@/hooks/useSettings";
import { supabase } from "@/lib/supabase/client";
import { OutlineIcon } from "./Icon";

export default function Sidebar() {
  const router = useRouter();
  const page = useDashboardStore((s) => s.page);
  const setPage = useDashboardStore((s) => s.setPage);
  const toggleTheme = useDashboardStore((s) => s.toggleTheme);
  const themeOverride = useDashboardStore((s) => s.themeOverride);
  const sysDark = useDashboardStore((s) => s.sysDark);
  const conversations = useDashboardStore((s) => s.conversations);
  const fetchConversations = useDashboardStore((s) => s.fetchConversations);
  const { session } = useSession();
  const { data: team } = useTeamMembers();

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const dark = isDark({ themeOverride, sysDark });
  // Badge = conversations that need a human (status needs_human -> handed_off).
  const handed = (conversations || []).filter((c) => mapConvStatus(c.status) === "handed_off").length;

  const me = team?.find((a) => a.user_id === session?.user.id);
  const displayName = me?.name || session?.user.email || "Account";
  const displayRole = me ? `${me.role[0].toUpperCase()}${me.role.slice(1)}` : "";
  const initials = displayName
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const signOut = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  return (
    <aside className="side">
      <div className="logo">
        <div className="mark">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
            <path d="M12 3v18" />
            <path d="M3 12h18" />
            <path d="M5.6 5.6l12.8 12.8" />
            <path d="M18.4 5.6 5.6 18.4" />
          </svg>
        </div>
        <span>
          OmniChat <span className="mut">AI</span>
        </span>
      </div>

      <nav style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {NAV_ITEMS.map((n) => {
          const badge = n.id === "inbox" && handed ? String(handed) : "";
          return (
            <button
              key={n.id}
              className={"navi" + (page === n.id ? " on" : "")}
              onClick={() => setPage(n.id as PageId)}
            >
              <OutlineIcon d={n.d} />
              <span>{n.label}</span>
              {badge && <span className="nbdg">{badge}</span>}
            </button>
          );
        })}
      </nav>

      <div className="f1" />

      <a className="navi" href="/playground">
        <OutlineIcon d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <span>Try your agent</span>
      </a>

      <button className="navi" onClick={toggleTheme}>
        <OutlineIcon d={dark ? THEME_ICON.dark : THEME_ICON.light} />
        <span>{dark ? "Light mode" : "Dark mode"}</span>
      </button>

      <div
        className="fx ac gap10"
        style={{ padding: "10px 8px 4px", borderTop: "1px solid var(--bd)", marginTop: 8 }}
      >
        <div className="avat">{initials}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="fw6 fs12 ell">{displayName}</div>
          <div className="mut fs11 ell">{displayRole}</div>
        </div>
        <button className="btn sm" onClick={signOut}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
