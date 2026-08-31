import { supabaseAdmin } from "@/lib/supabase/server";
import { generateCustomerReply } from "@/lib/ai/gemini";
import { sendToChannel } from "./registry";
import type { ChannelType } from "@/lib/orders/create";

const HISTORY_LIMIT = 10;

/** One normalised inbound message, whatever channel it arrived on. */
export interface InboundMessage {
  from: string;
  text: string;
  customerName: string;
  timestamp: string;
  providerMessageId: string;
}

export interface IngestResult {
  processed: number;
  skipped: number;
  failed: number;
}

/**
 * The single inbound pipeline for every channel.
 *
 * This replaces four near-identical route handlers (~765 lines) that differed
 * only in provider names — and had drifted apart in the process: two called
 * different AI functions, and two passed conversation history in a shape the
 * AI didn't understand, so the bot had amnesia on those channels.
 *
 * For each message: dedupe, find or create the conversation, store it, ask the
 * AI, store the answer, send it. A failure on one message doesn't abandon the
 * rest of the batch.
 */
export async function ingestInbound(
  businessId: string,
  channelType: ChannelType,
  messages: InboundMessage[]
): Promise<IngestResult> {
  const result: IngestResult = { processed: 0, skipped: 0, failed: 0 };
  if (messages.length === 0) return result;

  const { data: channel } = await supabaseAdmin
    .from("channels")
    .select("id, channel_type, access_token, phone_number_id, page_id, instagram_business_account_id")
    .eq("business_id", businessId)
    .eq("channel_type", channelType)
    .maybeSingle();

  for (const msg of messages) {
    try {
      // ---- Idempotency ----
      // Meta retries any delivery it doesn't get a prompt 200 for. Without
      // this check a retry stores the message twice, calls the AI twice, and
      // sends the customer two replies.
      if (msg.providerMessageId) {
        const { data: seen } = await supabaseAdmin
          .from("messages")
          .select("id")
          .eq("business_id", businessId)
          .eq("provider_message_id", msg.providerMessageId)
          .maybeSingle();

        if (seen) {
          result.skipped++;
          continue;
        }
      }

      // ---- Conversation ----
      const { data: existing } = await supabaseAdmin
        .from("conversations")
        .select("id, status")
        .eq("business_id", businessId)
        .eq("channel_type", channelType)
        .eq("customer_identifier", msg.from)
        .maybeSingle();

      let conversationId: string;
      let status: string;

      if (existing) {
        conversationId = existing.id;
        status = existing.status;
        await supabaseAdmin
          .from("conversations")
          .update({
            last_message_preview: msg.text.slice(0, 200),
            last_message_at: msg.timestamp,
            updated_at: new Date().toISOString(),
          })
          .eq("id", conversationId);
      } else {
        const { data: created, error } = await supabaseAdmin
          .from("conversations")
          .insert({
            business_id: businessId,
            channel_id: channel?.id ?? null,
            customer_name: msg.customerName,
            customer_identifier: msg.from,
            channel_type: channelType,
            status: "bot_active",
            last_message_preview: msg.text.slice(0, 200),
            last_message_at: msg.timestamp,
          })
          .select("id, status")
          .single();

        if (error || !created) {
          console.error("pipeline: could not create conversation:", error);
          result.failed++;
          continue;
        }
        conversationId = created.id;
        status = created.status;
      }

      // ---- Store the inbound message ----
      await supabaseAdmin.from("messages").insert({
        business_id: businessId,
        conversation_id: conversationId,
        channel_id: channel?.id ?? null,
        sender_type: "customer",
        direction: "incoming",
        body: msg.text,
        provider_message_id: msg.providerMessageId || null,
        created_at: msg.timestamp,
      });

      // A human has taken this conversation — record what the customer said,
      // but don't let the bot talk over them.
      if (status === "handed_off") {
        result.processed++;
        continue;
      }

      // ---- History, in the shape the AI actually expects ----
      const { data: history } = await supabaseAdmin
        .from("messages")
        .select("sender_type, body")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(HISTORY_LIMIT);

      const formatted = (history ?? [])
        .slice(0, -1) // drop the message we just stored
        .map((h: { sender_type: string; body: string }) => ({
          sender: h.sender_type === "customer" ? ("customer" as const) : ("bot" as const),
          text: h.body,
        }));

      // ---- Answer ----
      const reply = await generateCustomerReply(businessId, msg.text, formatted, {
        channelType,
        conversationId,
        customerName: msg.customerName,
      });

      const sent = await sendToChannel(channelType, msg.from, reply.text, channel);

      if (!sent.success) {
        console.error(`pipeline: ${channelType} send failed:`, sent.error);
      }

      // Record the reply even if the send failed, so the thread shows what the
      // bot decided — but mark it, so nobody mistakes it for delivered.
      await supabaseAdmin.from("messages").insert({
        business_id: businessId,
        conversation_id: conversationId,
        channel_id: channel?.id ?? null,
        sender_type: "bot",
        direction: "outgoing",
        body: sent.success ? reply.text : `[not delivered: ${sent.error}] ${reply.text}`,
        provider_message_id: sent.messageId ?? null,
      });

      await supabaseAdmin
        .from("conversations")
        .update({
          last_message_preview: reply.text.slice(0, 200),
          last_message_at: new Date().toISOString(),
        })
        .eq("id", conversationId);

      result.processed++;
    } catch (error) {
      console.error("pipeline: message failed:", error);
      result.failed++;
    }
  }

  return result;
}
