import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Connect a shop's own WhatsApp, Messenger or Instagram.
 *
 * Credentials are written with the service-role key and read back only as a
 * masked shape: an access token and an app secret are the keys to somebody's
 * business account, and the dashboard runs on the anon key in a browser.
 *
 * The verify token is generated here rather than typed. It is the string Meta
 * echoes back during the subscription handshake, and it is how a delivery is
 * traced to the shop that subscribed — asking a shop owner to invent one, and
 * to invent a different one from every other shop, is asking for a collision.
 */

const CHANNELS = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" } as const;
type Channel = keyof typeof CHANNELS;

function masked(secret: string | null | undefined): string | null {
  if (!secret) return null;
  if (secret.length < 12) return "(too short — check it was copied in full)";
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

export async function GET(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { data } = await supabaseAdmin
    .from("channels")
    .select("channel_type, status, access_token, app_secret, verify_token, phone_number_id, page_id, instagram_business_account_id")
    .eq("business_id", ctx.businessId);

  const origin = request.nextUrl.origin;

  return NextResponse.json({
    channels: ((data ?? []) as Array<Record<string, string | null>>).map((row) => ({
      channelType: row.channel_type,
      status: row.status,
      token: masked(row.access_token),
      appSecret: masked(row.app_secret),
      verifyToken: row.verify_token,
      accountId: row.phone_number_id ?? row.page_id ?? row.instagram_business_account_id,
    })),
    // Handed back so a shop owner copies rather than assembles them.
    webhookUrls: {
      whatsapp: `${origin}/api/webhooks/whatsapp`,
      messenger: `${origin}/api/channels/messenger`,
      instagram: `${origin}/api/channels/instagram`,
    },
  });
}

export async function POST(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "Send JSON." }, { status: 400 });
  }

  const channelType = String(body.channelType ?? "") as Channel;
  if (!(channelType in CHANNELS)) {
    return NextResponse.json({ message: "Choose WhatsApp, Messenger or Instagram." }, { status: 400 });
  }

  const accessToken = String(body.accessToken ?? "").trim();
  const appSecret = String(body.appSecret ?? "").trim();
  const accountId = String(body.accountId ?? "").trim();

  if (!accessToken) return NextResponse.json({ message: "Paste the access token." }, { status: 400 });
  if (!accountId) {
    return NextResponse.json(
      {
        message:
          channelType === "whatsapp"
            ? "Paste your Phone number ID."
            : channelType === "instagram"
              ? "Paste your Instagram account ID."
              : "Paste your Facebook Page ID.",
      },
      { status: 400 }
    );
  }

  // Kept if one already exists: re-verifying a webhook that already works
  // would be busywork caused by us, not by anything the shop changed.
  const { data: existing } = await supabaseAdmin
    .from("channels")
    .select("verify_token")
    .eq("business_id", ctx.businessId)
    .eq("channel_type", channelType)
    .maybeSingle();

  const verifyToken =
    (existing as { verify_token: string | null } | null)?.verify_token ??
    `omni_${crypto.randomBytes(16).toString("hex")}`;

  const row: Record<string, unknown> = {
    business_id: ctx.businessId,
    channel_type: channelType,
    name: CHANNELS[channelType],
    provider: "meta",
    status: "connected",
    access_token: accessToken,
    app_secret: appSecret || null,
    verify_token: verifyToken,
    updated_at: new Date().toISOString(),
  };

  if (channelType === "whatsapp") row.phone_number_id = accountId;
  else if (channelType === "instagram") row.instagram_business_account_id = accountId;
  else row.page_id = accountId;

  const { error } = await supabaseAdmin
    .from("channels")
    .upsert(row, { onConflict: "business_id,channel_type" });

  if (error) {
    if (error.code === "23505") {
      // The unique index on the account id: two shops cannot both claim one
      // number, or a customer's message would have two possible destinations.
      return NextResponse.json(
        { message: "That account is already connected to another shop." },
        { status: 409 }
      );
    }
    const missing = /column .*(verify_token|app_secret)/i.test(error.message);
    return NextResponse.json(
      {
        message: missing
          ? "Run supabase/migrations/005_per_shop_webhooks.sql in Supabase → SQL Editor first."
          : error.message,
      },
      { status: missing ? 503 : 500 }
    );
  }

  return NextResponse.json({
    connected: channelType,
    verifyToken,
    webhookUrl: `${request.nextUrl.origin}${
      channelType === "whatsapp" ? "/api/webhooks/whatsapp" : `/api/channels/${channelType}`
    }`,
    message: `${CHANNELS[channelType]} saved. Add the webhook URL and verify token below in Meta, then send yourself a test message.`,
  });
}

export async function DELETE(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const channelType = request.nextUrl.searchParams.get("channelType") ?? "";
  const { error } = await supabaseAdmin
    .from("channels")
    .delete()
    .eq("business_id", ctx.businessId)
    .eq("channel_type", channelType);

  if (error) return NextResponse.json({ message: error.message }, { status: 500 });
  return NextResponse.json({ disconnected: channelType });
}
