import { NextRequest, NextResponse } from "next/server";
import { handleWidgetMessage } from "@/lib/channels/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/widget/chat — the shop's website talking to its own agent.
 *
 * Public and unauthenticated by necessity: it is called from a stranger's
 * browser on the shop's site, where any credential would be readable in the
 * page source. The trust checks therefore live in handleWidgetMessage — the
 * widget must be switched on, the origin must be permitted, and the rate
 * limits are enforced against the database rather than this instance's memory,
 * which on serverless is per-container and resets constantly.
 */

/**
 * The widget is embedded on domains we don't control, so the browser will not
 * hand over the response without these. Echoing the caller's origin keeps the
 * per-shop allowlist in handleWidgetMessage as the single place that decides
 * who may talk — rather than duplicating that policy in two spellings.
 */
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400, headers });
  }

  const outcome = await handleWidgetMessage({
    businessId: String(body.businessId ?? ""),
    sessionId: String(body.sessionId ?? ""),
    text: String(body.message ?? body.text ?? ""),
    customerName: body.customerName ? String(body.customerName) : undefined,
    origin,
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status, headers });
  }

  return NextResponse.json(
    { reply: outcome.reply, conversationId: outcome.conversationId },
    { status: 200, headers }
  );
}
