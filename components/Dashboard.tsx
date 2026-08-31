"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "./Sidebar";
import Toast from "./Toast";
import Onboarding from "./Onboarding";
import Overview from "./pages/Overview";
import Inbox from "./pages/Inbox";
import Catalog from "./pages/Catalog";
import Orders from "./pages/Orders";
import Carts from "./pages/Carts";
import Campaigns from "./pages/Campaigns";
import Channels from "./pages/Channels";
import Settings from "./pages/Settings";
import { useDashboardStore, isDark } from "@/store/useDashboardStore";
import { useSession } from "@/hooks/useSession";
import { useCurrentBusinessId } from "@/hooks/useCurrentBusinessId";
import { useRealtimeInbox } from "@/hooks/useRealtimeInbox";
import { LoadingState } from "./State";

export default function Dashboard() {
  const router = useRouter();
  const page = useDashboardStore((s) => s.page);
  const themeOverride = useDashboardStore((s) => s.themeOverride);
  const sysDark = useDashboardStore((s) => s.sysDark);
  const setSysDark = useDashboardStore((s) => s.setSysDark);

  const { session, loading: sessionLoading } = useSession();
  const { data: businessId, isLoading: bizLoading } = useCurrentBusinessId();

  // Live updates for every page that reads conversations or messages.
  useRealtimeInbox(businessId);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSysDark(mq.matches);
    const fn = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [setSysDark]);

  useEffect(() => {
    if (!sessionLoading && !session) router.replace("/login");
  }, [sessionLoading, session, router]);

  const dark = isDark({ themeOverride, sysDark });

  if (sessionLoading || (session && bizLoading)) {
    return (
      <div className={"app" + (dark ? " dark" : "")}>
        <div className="f1" style={{ padding: 24 }}>
          <LoadingState rows={4} />
        </div>
      </div>
    );
  }

  if (!session) return null; // redirecting to /login

  if (!businessId) return <Onboarding session={session} />;

  return (
    <div className={"app" + (dark ? " dark" : "")}>
      <Sidebar />
      <main className="main">
        {page === "overview" && <Overview />}
        {page === "inbox" && <Inbox />}
        {page === "catalog" && <Catalog />}
        {page === "orders" && <Orders />}
        {page === "carts" && <Carts />}
        {page === "campaigns" && <Campaigns />}
        {page === "channels" && <Channels />}
        {page === "settings" && <Settings />}
        <Toast />
      </main>
    </div>
  );
}
