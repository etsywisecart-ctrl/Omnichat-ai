import { createWebhookHandlers } from "@/lib/channels/webhook-route";
import { messengerAdapter } from "@/lib/channels/messenger";

export const runtime = "nodejs";

/** Facebook Messenger webhook. */
export const { GET, POST } = createWebhookHandlers({
  channelType: "messenger",
  verifyTokenEnv: "MESSENGER_VERIFY_TOKEN",
  appSecretEnv: "MESSENGER_APP_SECRET",
  businessIdEnv: "MESSENGER_DEFAULT_BUSINESS_ID",
  parse: (body) =>
    messengerAdapter.parseWebhook(body).map((m) => ({
      from: m.from,
      text: m.text,
      customerName: m.customerName,
      timestamp: m.timestamp,
      providerMessageId: m.channelMessageId,
    })),
});
