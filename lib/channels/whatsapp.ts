const GRAPH_VERSION = "v20.0";

/**
 * Pull the useful sentence out of a Graph API error.
 *
 * Meta nests the part that actually names the problem — "template name does
 * not exist in the translation" — inside error.error_data.details, while the
 * outer message says only "Unsupported post request". Logging the raw body
 * technically records it and practically hides it.
 */
function graphError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: number; error_data?: { details?: string } };
    };
    const detail = parsed.error?.error_data?.details;
    const message = parsed.error?.message;
    if (message || detail) {
      return [message, detail].filter(Boolean).join(" — ");
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return `HTTP ${status} ${body}`.trim();
}

/**
 * Send an approved WhatsApp template.
 *
 * Meta only accepts free-form text within 24 hours of the customer's own last
 * message. Everything a campaign does happens outside that window by
 * definition, so a broadcast has to go as a pre-approved template — which is
 * why campaigns could be queued but never delivered.
 *
 * The template itself lives in Meta's Business Manager, not in this database:
 * `templateName` must match one Meta has approved, and the variables fill its
 * {{1}}, {{2}} … placeholders in order.
 */
export async function sendWhatsAppTemplate({
  to,
  templateName,
  languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en_US",
  variables = [],
  phoneNumberId,
  accessToken,
}: {
  to: string;
  templateName: string;
  languageCode?: string;
  variables?: string[];
  phoneNumberId: string;
  accessToken: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!phoneNumberId || !accessToken) {
    return { success: false, error: "Missing phoneNumberId or accessToken" };
  }
  if (!templateName) {
    return { success: false, error: "No template name was given for this campaign." };
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: to.replace(/[^0-9]/g, ""),
          type: "template",
          template: {
            name: templateName,
            language: { code: languageCode },
            // Only send a components array when there is something to fill.
            // An empty one is rejected by templates that take no variables.
            ...(variables.length > 0
              ? {
                  components: [
                    {
                      type: "body",
                      parameters: variables.map((text) => ({ type: "text", text })),
                    },
                  ],
                }
              : {}),
          },
        }),
      }
    );

    if (!response.ok) {
      const error = graphError(response.status, await response.text());
      console.error("WhatsApp template send failed:", error);
      return { success: false, error };
    }

    const data = (await response.json()) as { messages?: Array<{ id: string }> };
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("WhatsApp template send error:", message);
    return { success: false, error: message };
  }
}

/**
 * Send a WhatsApp message via Meta's Graph API v20.0
 */
export async function sendWhatsAppMessage({
  to,
  text,
  phoneNumberId,
  accessToken,
}: {
  to: string;
  text: string;
  phoneNumberId: string;
  accessToken: string;
}): Promise<{
  success: boolean;
  messageId?: string;
  error?: string;
}> {
  if (!phoneNumberId || !accessToken) {
    return {
      success: false,
      error: "Missing phoneNumberId or accessToken",
    };
  }

  try {
    const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/[^0-9]/g, ""), // Strip to numbers only
      type: "text",
      text: {
        body: text,
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
      const error = graphError(response.status, await response.text());
      console.error("WhatsApp API error:", error);
      return { success: false, error };
    }

    const data = (await response.json()) as { messages?: Array<{ id: string }> };
    const messageId = data.messages?.[0]?.id;

    return {
      success: true,
      messageId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("WhatsApp send error:", errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Parse a WhatsApp Cloud API webhook payload
 */
export function parseWhatsAppWebhook(body: {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          text?: { body: string };
          type: string;
        }>;
        contacts?: Array<{ profile?: { name: string }; wa_id: string }>;
      };
    }>;
  }>;
}): Array<{
  from: string;
  waMessageId: string;
  text: string;
  customerName: string;
  timestamp: string;
}> {
  const messages: Array<{
    from: string;
    waMessageId: string;
    text: string;
    customerName: string;
    timestamp: string;
  }> = [];

  if (!body.entry) return messages;

  for (const entry of body.entry) {
    if (!entry.changes) continue;

    for (const change of entry.changes) {
      const value = change.value;
      if (!value) continue;

      const msgs = value.messages || [];
      const contacts = value.contacts || [];

      const contactMap: Record<string, string> = {};
      for (const contact of contacts) {
        if (contact.wa_id) {
          contactMap[contact.wa_id] = contact.profile?.name || contact.wa_id;
        }
      }

      for (const msg of msgs) {
        if (msg.type === "text" && msg.text?.body) {
          messages.push({
            from: msg.from,
            waMessageId: msg.id,
            text: msg.text.body,
            customerName: contactMap[msg.from] || msg.from,
            timestamp: new Date(Number(msg.timestamp) * 1000).toISOString(),
          });
        }
      }
    }
  }

  return messages;
}
