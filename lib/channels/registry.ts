import { sendWhatsAppMessage } from "./whatsapp";
import { instagramAdapter } from "./instagram";
import { messengerAdapter } from "./messenger";

export type SendableChannel = "whatsapp" | "instagram" | "messenger";

/** The stored channel row, as far as sending is concerned. */
export interface ChannelCredentials {
  channel_type: string;
  access_token?: string | null;
  phone_number_id?: string | null;
  page_id?: string | null;
  instagram_business_account_id?: string | null;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send one outbound text on whichever channel a conversation belongs to.
 *
 * WhatsApp still exposes loose functions rather than implementing
 * ChannelAdapter, so this is where that difference is absorbed — callers just
 * say "send this there" and don't care which shape the adapter has.
 */
export async function sendToChannel(
  channelType: string,
  to: string,
  text: string,
  channel: ChannelCredentials | null
): Promise<SendResult> {
  if (!channel?.access_token) {
    return {
      success: false,
      error: `The ${channelType} channel isn't connected yet — add its credentials under Channels.`,
    };
  }

  switch (channelType) {
    case "whatsapp":
      if (!channel.phone_number_id) {
        return { success: false, error: "This WhatsApp channel has no phone number id." };
      }
      return sendWhatsAppMessage({
        to,
        text,
        phoneNumberId: channel.phone_number_id,
        accessToken: channel.access_token,
      });

    case "instagram":
      if (!channel.instagram_business_account_id) {
        return { success: false, error: "This Instagram channel has no business account id." };
      }
      return instagramAdapter.sendMessage({
        to,
        text,
        accessToken: channel.access_token,
        pageId: channel.instagram_business_account_id,
      });

    case "messenger":
      if (!channel.page_id) {
        return { success: false, error: "This Messenger channel has no page id." };
      }
      return messengerAdapter.sendMessage({
        to,
        text,
        accessToken: channel.access_token,
        pageId: channel.page_id,
      });

    default:
      return {
        success: false,
        error: `Replies aren't supported on the ${channelType} channel yet.`,
      };
  }
}

/** Milliseconds in WhatsApp's free-form reply window. */
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Meta only allows a free-form reply within 24 hours of the customer's own
 * last message; after that you must use a pre-approved template. Returns true
 * when a plain text reply is still allowed.
 */
export function isWithinSessionWindow(
  channelType: string,
  lastInboundAt: string | null | undefined
): boolean {
  if (channelType === "web") return true;
  if (!lastInboundAt) return false;
  return Date.now() - new Date(lastInboundAt).getTime() < SESSION_WINDOW_MS;
}
