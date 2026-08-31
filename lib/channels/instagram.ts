import type { ChannelAdapter, ParsedMessage } from "./adapter";
import { verifyMetaSignature } from "./verify";

/**
 * Instagram Direct Message Adapter
 * Handles sending DMs and parsing incoming messages via Meta Graph API
 */
export const instagramAdapter: ChannelAdapter = {
  /**
   * Send an Instagram DM via Meta's Graph API v20.0
   */
  async sendMessage({ to, text, accessToken, pageId }) {
    if (!pageId || !accessToken) {
      return {
        success: false,
        error: "Missing pageId or accessToken",
      };
    }

    try {
      const url = `https://graph.instagram.com/v20.0/${pageId}/messages`;

      const payload = {
        messaging_type: "MESSAGE_TAG",
        tag: "HUMAN_AGENT",
        recipient: {
          id: to,
        },
        message: {
          text: text,
        },
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Instagram API error:", error);
        return {
          success: false,
          error: `Instagram API error: ${response.status} ${error}`,
        };
      }

      const data = (await response.json()) as { message_id?: string };
      const messageId = data.message_id;

      return {
        success: true,
        messageId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("Instagram send error:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  },

  /**
   * Parse an Instagram webhook payload
   */
  parseWebhook(body: unknown): ParsedMessage[] {
    const messages: ParsedMessage[] = [];

    try {
      const payload = body as {
        entry?: Array<{
          changes?: Array<{
            value?: {
              data?: Array<{
                from: { id: string; username?: string };
                to?: { data: Array<{ id: string; username?: string }> };
                message?: string;
                id: string;
                created_timestamp: number;
              }>;
            };
          }>;
        }>;
      };

      if (!payload.entry) return messages;

      for (const entry of payload.entry) {
        if (!entry.changes) continue;

        for (const change of entry.changes) {
          const value = change.value;
          if (!value?.data) continue;

          for (const msg of value.data) {
            if (msg.message) {
              messages.push({
                from: msg.from.id,
                channelMessageId: msg.id,
                text: msg.message,
                customerName: msg.from.username || msg.from.id,
                timestamp: new Date(msg.created_timestamp * 1000).toISOString(),
              });
            }
          }
        }
      }
    } catch (error) {
      console.error("Instagram webhook parse error:", error);
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
