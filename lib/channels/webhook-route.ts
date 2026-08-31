import { NextRequest, NextResponse } from "next/server";
import { verifyMetaSignature, verifyHubToken } from "./verify";
import { ingestInbound, type InboundMessage } from "./pipeline";
import type { ChannelType } from "@/lib/orders/create";

export interface WebhookConfig {
  channelType: ChannelType;
  /** Env var names, so a misconfigured channel names itself in the logs. */
  verifyTokenEnv: string;
  appSecretEnv: string;
  businessIdEnv: string;
  parse: (body: unknown) => InboundMessage[];
}

/**
 * Build the GET (Meta's subscription handshake) and POST (inbound messages)
 * handlers for one channel.
 *
 * All four webhook routes were separate ~190-line copies of this. They had
 * already drifted — different AI functions, different history handling, one
 * missing a channel_id — which is exactly what duplication does over time.
 */
export function createWebhookHandlers(config: WebhookConfig) {
  async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("hub.mode");
    const token = searchParams.get("hub.verify_token");
    const challenge = searchParams.get("hub.challenge");

    if (mode === "subscribe" && verifyHubToken(token, process.env[config.verifyTokenEnv]) && challenge) {
      return new NextResponse(challenge, { status: 200 });
    }
    return new NextResponse("Webhook verification failed", { status: 403 });
  }

  async function POST(request: NextRequest) {
    try {
      const bodyText = await request.text();
      const signature = request.headers.get("x-hub-signature-256") ?? "";

      if (!verifyMetaSignature(bodyText, signature, process.env[config.appSecretEnv] ?? "")) {
        return new NextResponse("Invalid signature", { status: 403 });
      }

      const businessId = process.env[config.businessIdEnv];
      if (!businessId) {
        console.error(`${config.businessIdEnv} is not configured`);
        // 200 so Meta stops retrying a request we can never process.
        return NextResponse.json({ received: true, error: "business_not_configured" });
      }

      let messages: InboundMessage[] = [];
      try {
        messages = config.parse(JSON.parse(bodyText));
      } catch (error) {
        console.error(`${config.channelType}: could not parse webhook body:`, error);
        return NextResponse.json({ received: true, error: "unparseable" });
      }

      if (messages.length === 0) {
        return NextResponse.json({ received: true, messages: 0 });
      }

      const result = await ingestInbound(businessId, config.channelType, messages);
      return NextResponse.json({ received: true, ...result });
    } catch (error) {
      console.error(`${config.channelType} webhook error:`, error);
      // Still 200: a 500 makes Meta retry, which duplicates the customer's
      // message. The dedupe guard would catch it, but not retrying is better.
      return NextResponse.json({ received: true, error: "internal" });
    }
  }

  return { GET, POST };
}
