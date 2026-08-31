import { createWebhookHandlers } from "@/lib/channels/webhook-route";
import { instagramAdapter } from "@/lib/channels/instagram";

export const runtime = "nodejs";

/** Instagram Direct webhook. */
export const { GET, POST } = createWebhookHandlers({
  channelType: "instagram",
  verifyTokenEnv: "INSTAGRAM_VERIFY_TOKEN",
  appSecretEnv: "INSTAGRAM_APP_SECRET",
  businessIdEnv: "INSTAGRAM_DEFAULT_BUSINESS_ID",
  parse: (body) =>
    instagramAdapter.parseWebhook(body).map((m) => ({
      from: m.from,
      text: m.text,
      customerName: m.customerName,
      timestamp: m.timestamp,
      providerMessageId: m.channelMessageId,
    })),
});
