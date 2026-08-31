import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/webhooks/stripe
 *
 * Stripe calls this when a checkout completes. Signature verification is done
 * by the Stripe SDK against the raw request body — never hand-rolled, and
 * never skipped: a missing secret is a hard failure, not a bypass.
 *
 * This runs with the service-role client because Stripe is not a signed-in
 * user; the event's own metadata names the order, and the signature is what
 * proves the request is genuine.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const apiKey = process.env.STRIPE_SECRET_KEY;

  if (!secret || !apiKey) {
    console.error("Stripe webhook rejected: STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY missing");
    return NextResponse.json(
      { error: "not_configured", message: "Stripe webhooks are not configured." },
      { status: 500 }
    );
  }

  const body = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";

  let event: Stripe.Event;
  try {
    const stripe = new Stripe(apiKey);
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch (error) {
    console.error("Stripe signature verification failed:", error);
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.order_id;
      const businessId = session.metadata?.business_id;

      if (!orderId || !businessId) {
        // Not one of ours — acknowledge so Stripe stops retrying.
        return NextResponse.json({ received: true, ignored: "missing_metadata" });
      }

      const { data: order, error: updateError } = await supabaseAdmin
        .from("orders")
        .update({
          status: "paid",
          stripe_payment_intent_id:
            typeof session.payment_intent === "string" ? session.payment_intent : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId)
        .eq("business_id", businessId)
        .select("id, display_id, conversation_id")
        .maybeSingle();

      if (updateError) {
        console.error("Failed to mark order paid:", updateError);
        return NextResponse.json({ error: "update_failed" }, { status: 500 });
      }

      // Confirm in the chat thread the order came from.
      if (order?.conversation_id) {
        await supabaseAdmin.from("messages").insert({
          business_id: businessId,
          conversation_id: order.conversation_id,
          sender_type: "system",
          direction: "outgoing",
          body: `Payment received — order ${order.display_id} is confirmed.`,
        });
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook handling error:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
