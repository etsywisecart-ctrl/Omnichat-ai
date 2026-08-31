"use client";

import { useEffect } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import { useCurrentBusinessId } from "@/hooks/useCurrentBusinessId";
import { EmptyState, LoadingState, NotConnectedNotice } from "@/components/State";
import type { PageId } from "@/lib/types";

export default function Overview() {
  const setPage = useDashboardStore((s) => s.setPage);
  const stats = useDashboardStore((s) => s.stats);
  const conversations = useDashboardStore((s) => s.conversations);
  const dashboardLoading = useDashboardStore((s) => s.dashboardLoading);
  const refreshDashboard = useDashboardStore((s) => s.refreshDashboard);

  const { data: businessId, isLoading: bizLoading } = useCurrentBusinessId();

  // Fetch real dashboard data from the backend API on mount.
  useEffect(() => {
    refreshDashboard();
  }, [refreshDashboard]);

  const h = new Date().getHours();
  const greeting =
    h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";

  const loading = bizLoading || dashboardLoading;
  const notConnected = !bizLoading && !businessId;

  // ---- KPI values from real stats (not hardcoded 0) ----
  const botHandled = stats?.open ?? 0;
  const handed = stats?.waiting_for_human ?? 0;
  const openConvs = botHandled + handed;
  const pendingOrders = stats?.pending_orders ?? [];
  const pendingPaymentTotal = (stats?.pending_payment_total_cents ?? 0) / 100;
  const atRiskCartsCount = stats?.carts_at_risk ?? 0;

  const kpis = [
    {
      l: "Open conversations",
      v: String(openConvs),
      d: `${botHandled} bot-handled · ${handed} with humans`,
    },
    {
      l: "Waiting for a human",
      v: String(handed),
      d: handed ? `${handed} unassigned or in progress` : "All caught up",
    },
    {
      l: "Pending payment",
      v: pendingOrders.length ? `$${pendingPaymentTotal.toFixed(0)}` : "$0",
      d: pendingOrders.length
        ? `${pendingOrders.length} order(s)`
        : "No pending orders",
    },
    {
      l: "Carts at risk",
      v: String(atRiskCartsCount),
      d: atRiskCartsCount ? "Needs a reminder" : "No carts at risk",
    },
  ];

  // ---- "Needs attention" items ----
  type AttnItem = { dotCls: string; t: string; d: string; act: string; go: PageId };
  const attn: AttnItem[] = [];

  // Conversations handed off to a human.
  const waitingConvs = (conversations || []).filter((c) => c.status === "handed_off");
  if (waitingConvs.length > 0) {
    attn.push({
      dotCls: "adot warn",
      t: `${waitingConvs.length} conversation(s) waiting for a human`,
      d: waitingConvs
        .map((c) => c.customer_name || c.customer_identifier)
        .slice(0, 3)
        .join(" · "),
      act: "Open inbox",
      go: "inbox",
    });
  }

  // Pending payment orders (from stats, pre-fetched from backend).
  pendingOrders.slice(0, 2).forEach((o) => {
    attn.push({
      dotCls: "adot warn",
      t: `${o.display_id || o.id} pending payment`,
      d: `${o.customer_name || "Unknown customer"} · $${(
        (o.total_cents ?? 0) / 100
      ).toFixed(2)}`,
      act: "View orders",
      go: "orders",
    });
  });

  // Carts at risk.
  if (atRiskCartsCount > 0) {
    attn.push({
      dotCls: "adot err",
      t: `${atRiskCartsCount} cart(s) need a reminder`,
      d: "Check the recovery window for each",
      act: "Review carts",
      go: "carts",
    });
  }

  return (
    <div className="pwrap">
      <div className="page" data-screen-label="Overview">
        <div className="phead">
          <div>
            <h1 className="h1">{greeting}</h1>
            <p className="sub">Here&apos;s what your agent is handling across channels.</p>
          </div>
          <button className="btn" onClick={() => setPage("inbox")}>
            Open inbox
          </button>
        </div>

        {notConnected && <NotConnectedNotice />}

        {loading ? (
          <LoadingState rows={4} />
        ) : (
          <>
            <div className="kgrid">
              {kpis.map((k) => (
                <div className="card kpi" key={k.l}>
                  <div className="kl">{k.l}</div>
                  <div className="kv">{k.v}</div>
                  <div className="kd">{k.d}</div>
                </div>
              ))}
            </div>

            <div className="ogrid mt16">
              <div className="card">
                <div className="cardh">Needs attention</div>
                {attn.length === 0 ? (
                  <EmptyState title="Nothing needs attention" desc="You're all caught up." />
                ) : (
                  attn.map((a, i) => (
                    <div className="arow" key={i}>
                      <div className={a.dotCls} />
                      <div className="f1" style={{ minWidth: 0 }}>
                        <div className="fw6 fs13">{a.t}</div>
                        <div className="mut fs12 mt2">{a.d}</div>
                      </div>
                      <button
                        className="btn sm noshrink"
                        onClick={() => setPage(a.go)}
                      >
                        {a.act}
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="card">
                <div className="cardh">
                  Agent activity
                  <span className="mut fs11" style={{ fontWeight: 500 }}>
                    every message + tool call is logged
                  </span>
                </div>
                <EmptyState
                  icon="📡"
                  title="No activity yet"
                  desc="Once your agent starts handling conversations, tool calls and webhooks will show up here."
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
