import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { sendToChannel, isWithinSessionWindow } from "@/lib/channels/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LENGTH = 4000;

/**
 * POST /api/dashboard/conversation/:id/reply
 *
 * Send an agent's reply on whatever channel the conversation came in on.
 *
 * The message row is only written AFTER the provider accepts it. Recording it
 * first would put text in the thread that the customer never received — the
 * agent would believe they had answered.
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
    const text = (body?.text ?? "").trim();

    if (!text) {
      return NextResponse.json(
        { error: "empty", message: "Type a message before sending." },
        { status: 400 }
      );
    }
    if (text.length > MAX_LENGTH) {
      return NextResponse.json(
        { error: "too_long", message: `Messages are limited to ${MAX_LENGTH} characters.` },
        { status: 400 }
      );
    }

    // The conversation must belong to the caller's business.
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("id, customer_identifier, channel_type, channel_id")
      .eq("id", id)
      .eq("business_id", businessId)
      .maybeSingle();

    if (convError) throw convError;
    if (!conversation) {
      return NextResponse.json(
        { error: "not_found", message: "Conversation not found." },
        { status: 404 }
      );
    }

    if (!conversation.customer_identifier) {
      return NextResponse.json(
        {
          error: "no_recipient",
          message: "This conversation has no contact address to reply to.",
        },
        { status: 400 }
      );
    }

    // When did the customer last write? That sets the 24-hour window.
    const { data: lastInbound } = await supabase
      .from("messages")
      .select("created_at")
      .eq("conversation_id", id)
      .eq("direction", "incoming")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!isWithinSessionWindow(conversation.channel_type, lastInbound?.created_at)) {
      return NextResponse.json(
        {
          error: "outside_window",
          message:
            "It's been more than 24 hours since this customer's last message, so the channel only allows a pre-approved template — not a free-form reply.",
        },
        { status: 409 }
      );
    }

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
        { error: "send_failed", message: sent.error ?? "The channel rejected the message." },
        { status: 502 }
      );
    }

    const now = new Date().toISOString();

    const { data: message, error: msgError } = await supabase
      .from("messages")
      .insert({
        business_id: businessId,
        conversation_id: id,
        channel_id: conversation.channel_id,
        sender_type: "agent",
        direction: "outgoing",
        body: text,
        provider_message_id: sent.messageId ?? null,
        created_at: now,
      })
      .select()
      .single();

    if (msgError) throw msgError;

    // A human answering means the bot should stop; mark it handed off.
    await supabase
      .from("conversations")
      .update({
        last_message_preview: text.slice(0, 200),
        last_message_at: now,
        status: "handed_off",
        updated_at: now,
      })
      .eq("id", id)
      .eq("business_id", businessId);

    return NextResponse.json({ success: true, message });
  } catch (error) {
    console.error("reply error:", error);
    return NextResponse.json(
      { error: "server_error", message: "Couldn't send that reply." },
      { status: 500 }
    );
  }
}
