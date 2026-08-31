import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { createOrder, CHANNEL_TYPES, type ChannelType } from "@/lib/orders/create";

export const runtime = "nodejs";

interface CreateOrderRequest {
  conversation_id?: string;
  customer_name: string;
  channel_type: ChannelType;
  items: Array<{ product_id: string; quantity: number }>;
  create_payment_link?: boolean;
}

/**
 * POST /api/orders/create
 *
 * Creates an order for the signed-in user's business. The business comes from
 * the session, never the request body, and every price comes from the
 * database — see lib/orders/create.ts, which the AI's create_order tool uses
 * too so both paths behave identically.
 */
export async function POST(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  try {
    const body = (await request.json().catch(() => null)) as CreateOrderRequest | null;

    if (!body?.customer_name || !Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: "bad_request", message: "customer_name and at least one item are required." },
        { status: 400 }
      );
    }

    const result = await createOrder(ctx.supabase, {
      businessId: ctx.businessId,
      customerName: body.customer_name,
      channelType: CHANNEL_TYPES.includes(body.channel_type) ? body.channel_type : "web",
      conversationId: body.conversation_id ?? null,
      items: body.items,
      createPaymentLink: body.create_payment_link,
      appUrl: process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin,
    });

    if (!result.ok) {
      const status = result.code === "insert_failed" || result.code === "lookup_failed" ? 500 : 400;
      return NextResponse.json({ error: result.code, message: result.error }, { status });
    }

    return NextResponse.json({
      success: true,
      order: result.order,
      ...(result.warning ? { warning: result.warning } : {}),
    });
  } catch (error) {
    console.error("Order creation error:", error);
    return NextResponse.json(
      { error: "server_error", message: "Couldn't create the order." },
      { status: 500 }
    );
  }
}
