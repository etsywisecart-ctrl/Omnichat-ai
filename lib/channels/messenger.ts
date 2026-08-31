import type { ChannelAdapter, ParsedMessage } from "./adapter";
import { verifyMetaSignature } from "./verify";

/**
 * Facebook Messenger Adapter
 * Handles sending messages and parsing incoming webhooks via Meta Graph API
 */
export const messengerAdapter: ChannelAdapter = {
  /**
   * Send a Facebook Messenger message via Meta's Graph API v20.0
   */
  async sendMessage({ to, text, accessToken, pageId }) {
    if (!pageId || !accessToken) {
      return {
        success: false,
        error: "Missing pageId or accessToken",
      };
    }

    try {
      const url = `https://graph.facebook.com/v20.0/me/messages`;

      const payload = {
        recipient: {
          id: to,
        },
        messaging_type: "RESPONSE",
        message: {
          text: text,
        },
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          access_token: accessToken,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Messenger API error:", error);
        return {
          success: false,
          error: `Messenger API error: ${response.status} ${error}`,
        };
      }

      const data = (await response.json()) as {
        message_id?: string;
        recipient_id?: string;
      };
      const messageId = data.message_id;

      return {
        success: true,
        messageId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("Messenger send error:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  },

  /**
   * Parse a Facebook Messenger webhook payload
   */
  parseWebhook(body: unknown): ParsedMessage[] {
    const messages: ParsedMessage[] = [];

    try {
      const payload = body as {
        entry?: Array<{
          messaging?: Array<{
            sender: { id: string };
            recipient: { id: string };
            timestamp: number;
            message?: {
              mid: string;
              text?: string;
              attachments?: Array<unknown>;
            };
          }>;
        }>;
      };

      if (!payload.entry) return messages;

      for (const entry of payload.entry) {
        if (!entry.messaging) continue;

        for (const msg of entry.messaging) {
          if (msg.message?.text) {
            messages.push({
              from: msg.sender.id,
              channelMessageId: msg.message.mid,
              text: msg.message.text,
              customerName: msg.sender.id, // Messenger doesn't provide name in webhook; would need separate API call
              timestamp: new Date(msg.timestamp).toISOString(),
            });
          }
        }
      }
    } catch (error) {
      console.error("Messenger webhook parse error:", error);
    }

    return messages;
  },

  /**
   * Verify Meta's webhook signature (X-Hub-Signature-256)
   */
  verifySignature(body: string, signature: string, appSecret: string): boolean {
    return verifyMetaSignature(body, signature, appSecret);
  },
};
