import { NextRequest, NextResponse } from "next/server";
import { verifyMetaSignature, verifyHubToken } from "./verify";
import { ingestInbound, type InboundMessage } from "./pipeline";
import { accountIdFromPayload, accountColumn } from "./identify";
import { supabaseAdmin } from "@/lib/supabase/server";
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
  /**
   * Meta's subscription handshake.
   *
   * Each shop generates its own verify token when it connects, so the token
   * presented here identifies which shop is being subscribed. The deployment
   * token is still accepted, for the installation that was set up before
   * shops carried their own.
   */
  async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("hub.mode");
    const token = searchParams.get("hub.verify_token");
    const challenge = searchParams.get("hub.challenge");

    if (mode !== "subscribe" || !challenge || !token) {
      return new NextResponse("Webhook verification failed", { status: 403 });
    }

    if (verifyHubToken(token, process.env[config.verifyTokenEnv])) {
      return new NextResponse(challenge, { status: 200 });
    }

    const { data: channel } = await supabaseAdmin
      .from("channels")
      .select("id")
      .eq("channel_type", config.channelType)
      .eq("verify_token", token)
      .maybeSingle();

    if (channel) return new NextResponse(challenge, { status: 200 });

    return new NextResponse("Webhook verification failed", { status: 403 });
  }

  async function POST(request: NextRequest) {
    try {
      const bodyText = await request.text();
      const signature = request.headers.get("x-hub-signature-256") ?? "";

      let payload: unknown;
      try {
        payload = JSON.parse(bodyText);
      } catch (error) {
        console.error(`${config.channelType}: could not parse webhook body:`, error);
        return NextResponse.json({ received: true, error: "unparseable" });
      }

      // ---- Which shop is this for? ----
      //
      // Previously: whichever business a deployment-wide environment variable
      // named. That is correct for exactly one customer, and silently routes
      // every other shop's customers into their inbox.
      const accountId = accountIdFromPayload(config.channelType, payload);
      let businessId = process.env[config.businessIdEnv] ?? "";
      let appSecret = process.env[config.appSecretEnv] ?? "";

      if (accountId) {
        const { data: channel } = await supabaseAdmin
          .from("channels")
          .select("business_id, app_secret")
          .eq("channel_type", config.channelType)
          .eq(accountColumn(config.channelType), accountId)
          .maybeSingle();

        const owner = channel as { business_id: string; app_secret: string | null } | null;
        if (owner) {
          businessId = owner.business_id;
          // The shop's own secret, so one shop's key cannot authenticate a
          // delivery addressed to another.
          if (owner.app_secret) appSecret = owner.app_secret;
        }
      }

      // Verified after the shop is known, because which secret is correct
      // depends on which shop the delivery is for.
      if (!verifyMetaSignature(bodyText, signature, appSecret)) {
        return new NextResponse("Invalid signature", { status: 403 });
      }

      if (!businessId) {
        console.error(
          `${config.channelType}: no shop is connected for account ${accountId ?? "(unknown)"}`
        );
        // 200 so Meta stops retrying a request we can never process.
        return NextResponse.json({ received: true, error: "business_not_configured" });
      }

      let messages: InboundMessage[] = [];
      try {
        messages = config.parse(payload);
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
