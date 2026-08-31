import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { sendToChannel, isWithinSessionWindow } from "@/lib/channels/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function defaultMessage(customerName: string, itemsSummary: string | null): string {
  const who = customerName && customerName !== "Guest" ? `Hi ${customerName}` : "Hi";
  const what = itemsSummary ? ` — you left ${itemsSummary} in your cart` : " — you left something in your cart";
  return `${who}${what}. Would you like to finish your order? Just reply and I'll help.`;
}

/**
 * POST /api/carts/:id/remind
 *
 * Send one abandoned-cart reminder on the channel the cart came from.
 *
 * This used to write a note string to carts.reminder_sent_note and toast
 * "Reminder sent" — no message ever left the system. Now the note is only
 * written after the channel accepts the send, so the column means what it says.
 *
 * One reminder per cart: repeated nudges read as spam and risk the number.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { supabase, businessId } = ctx;
  const { id } = await params;

  try {
    const body = (await request.json().catch(() => null)) as { text?: string } | null;

    const { data: cart, error: cartError } = await supabase
      .from("carts")
      .select("id, conversation_id, customer_name, channel_type, items_summary, status, reminder_sent_note")
      .eq("id", id)
      .eq("business_id", businessId)
      .maybeSingle();

    if (cartError) throw cartError;
    if (!cart) {
      return NextResponse.json({ error: "not_found", message: "Cart not found." }, { status: 404 });
    }

    if (cart.reminder_sent_note) {
      return NextResponse.json(
        {
          error: "already_sent",
          message: "This cart has already had its one reminder.",
        },
        { status: 409 }
      );
    }

    if (!cart.conversation_id) {
      return NextResponse.json(
        {
          error: "no_conversation",
          message: "This cart isn't linked to a conversation, so there's nowhere to send a reminder.",
        },
        { status: 400 }
      );
    }

    const { data: conversation } = await supabase
      .from("conversations")
      .select("id, customer_identifier, channel_type, channel_id")
      .eq("id", cart.conversation_id)
      .eq("business_id", businessId)
      .maybeSingle();

    if (!conversation?.customer_identifier) {
      return NextResponse.json(
        {
          error: "no_recipient",
          message: "That conversation has no contact address to send to.",
        },
        { status: 400 }
      );
    }

    // The same 24-hour rule the Inbox composer honours.
    const { data: lastInbound } = await supabase
      .from("messages")
      .select("created_at")
      .eq("conversation_id", conversation.id)
      .eq("direction", "incoming")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const inWindow = isWithinSessionWindow(conversation.channel_type, lastInbound?.created_at);

    if (!inWindow) {
      return NextResponse.json(
        {
          error: "outside_window",
          message:
            "This customer last wrote over 24 hours ago, so the channel requires a pre-approved template. Template sending isn't wired up yet, so nothing was sent.",
        },
        { status: 409 }
      );
    }

    const text = (body?.text ?? "").trim() || defaultMessage(cart.customer_name, cart.items_summary);

    const { data: channel } = await supabase
      .from("channels")
      .select("channel_type, access_token, phone_number_id, page_id, instagram_business_account_id")
      .eq("business_id", businessId)
      .eq("channel_type", conversation.channel_type)
      .maybeSingle();

    const sent = await sendToChannel(
      conversation.channel_type,
      conversation.customer_identifier,
      text,
      channel
    );

    if (!sent.success) {
      return NextResponse.json(
        { error: "send_failed", message: sent.error ?? "The channel rejected the reminder." },
        { status: 502 }
      );
    }

    const now = new Date().toISOString();

    // Only now is it true that a reminder was sent.
    await supabase.from("messages").insert({
      business_id: businessId,
      conversation_id: conversation.id,
      channel_id: conversation.channel_id,
      sender_type: "system",
      direction: "outgoing",
      body: text,
      provider_message_id: sent.messageId ?? null,
      created_at: now,
    });

    const { data: updated } = await supabase
      .from("carts")
      .update({
        reminder_sent_note: `Sent ${new Date(now).toLocaleString()} · free-form`,
        updated_at: now,
      })
      .eq("id", id)
      .eq("business_id", businessId)
      .select("id, reminder_sent_note")
      .maybeSingle();

    await supabase
      .from("conversations")
      .update({ last_message_preview: text.slice(0, 200), last_message_at: now, updated_at: now })
      .eq("id", conversation.id)
      .eq("business_id", businessId);

    return NextResponse.json({ success: true, cart: updated, sentText: text });
  } catch (error) {
    console.error("cart reminder error:", error);
    return NextResponse.json(
      { error: "server_error", message: "Couldn't send that reminder." },
      { status: 500 }
    );
  }
}
