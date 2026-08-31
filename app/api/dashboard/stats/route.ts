import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/stats
 * Aggregate counts for the Overview page, scoped to the caller's business.
 */
export async function GET(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { supabase, businessId } = ctx;

  try {
    const [convRes, orderRes, cartRes] = await Promise.all([
      supabase.from("conversations").select("status").eq("business_id", businessId),
      supabase
        .from("orders")
        .select("id, status, total_cents, display_id, customer_name, currency")
        .eq("business_id", businessId),
      supabase.from("carts").select("status").eq("business_id", businessId),
    ]);

    const conversations = convRes.data ?? [];
    const orders = orderRes.data ?? [];
    const carts = cartRes.data ?? [];

    const countBy = <T extends { status: string | null }>(rows: T[]) =>
      rows.reduce<Record<string, number>>((acc, r) => {
        const key = r.status || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

    const convCounts = countBy(conversations);
    const orderCounts = countBy(orders);
    const cartCounts = countBy(carts);

    // "open" covers both the legacy 'open' value and the bot-handled state.
    const botHandled = (convCounts["bot_active"] || 0) + (convCounts["open"] || 0);
    const handedOff = convCounts["handed_off"] || 0;

    const pending = orders.filter(
      (o: { status: string }) => o.status === "pending_payment" || o.status === "draft"
    );

    return NextResponse.json({
      open: botHandled,
      waiting_for_human: handedOff,
      pending_payment: pending.length,
      pending_payment_total_cents: pending.reduce(
        (sum: number, o: { total_cents: number | null }) => sum + (o.total_cents ?? 0),
        0
      ),
      pending_orders: pending.slice(0, 10).map(
        (o: {
          id: string;
          display_id: string | null;
          customer_name: string | null;
          total_cents: number | null;
          currency: string | null;
        }) => ({
          id: o.id,
          display_id: o.display_id,
          customer_name: o.customer_name,
          total_cents: o.total_cents,
          currency: o.currency ?? "USD",
        })
      ),
      carts_at_risk: cartCounts["abandoned"] || 0,
      needs_attention: handedOff + (cartCounts["abandoned"] || 0),
      agent_activity: {
        open: botHandled,
        waiting: handedOff,
        resolved: convCounts["closed"] || 0,
        total: conversations.length,
      },
      orders: {
        total: orders.length,
        pending: pending.length,
        paid: orderCounts["paid"] || 0,
        abandoned: orderCounts["cancelled"] || 0,
      },
      total_conversations: conversations.length,
    });
  } catch (error) {
    console.error("dashboard/stats error:", error);
    return NextResponse.json(
      { error: "server_error", message: "Couldn't load dashboard stats." },
      { status: 500 }
    );
  }
}
