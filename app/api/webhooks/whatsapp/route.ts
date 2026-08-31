import { createWebhookHandlers } from "@/lib/channels/webhook-route";
import { parseWhatsAppWebhook } from "@/lib/channels/whatsapp";

export const runtime = "nodejs";

/** WhatsApp Cloud API webhook. Point Meta at /api/webhooks/whatsapp. */
export const { GET, POST } = createWebhookHandlers({
  channelType: "whatsapp",
  verifyTokenEnv: "WHATSAPP_VERIFY_TOKEN",
  appSecretEnv: "WHATSAPP_APP_SECRET",
  businessIdEnv: "WHATSAPP_DEFAULT_BUSINESS_ID",
  parse: (body) =>
    parseWhatsAppWebhook(body as Parameters<typeof parseWhatsAppWebhook>[0]).map((m) => ({
      from: m.from,
      text: m.text,
      customerName: m.customerName,
      timestamp: m.timestamp,
      providerMessageId: m.waMessageId,
    })),
});
