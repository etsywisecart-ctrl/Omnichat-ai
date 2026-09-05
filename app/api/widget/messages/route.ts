import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, serviceRoleKeyProblem } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/widget/messages — what the shop has said since the visitor last looked.
 *
 * The widget's own send is request/response, so a reply typed by a human in the
 * Inbox had nowhere to go: the agent could answer and the visitor would never
 * see it. This is the other half of that conversation.
 *
 * Scoped to one session id, which the visitor's browser generated and only it
 * knows. That is what stands in for authentication here — the same basis the
 * chat itself runs on — so the query is pinned to the conversation belonging to
 * that exact session and never accepts a conversation id from the caller.
 */

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function GET(request: NextRequest) {
  const headers = corsHeaders(request.headers.get("origin"));
  if (serviceRoleKeyProblem()) return NextResponse.json({ messages: [] }, { headers });

  const businessId = (request.nextUrl.searchParams.get("businessId") ?? "").trim();
  const sessionId = (request.nextUrl.searchParams.get("sessionId") ?? "").trim();
  const since = request.nextUrl.searchParams.get("since") ?? "";

  if (!businessId || !/^[A-Za-z0-9_-]{8,100}$/.test(sessionId)) {
    return NextResponse.json({ messages: [] }, { headers });
  }

  const { data: conversation } = await supabaseAdmin
    .from("conversations")
    .select("id, status")
    .eq("business_id", businessId)
    .eq("channel_type", "web")
    .eq("customer_identifier", sessionId)
    .maybeSingle();

  if (!conversation) return NextResponse.json({ messages: [] }, { headers });

  let query = supabaseAdmin
    .from("messages")
    .select("id, body, sender_type, created_at")
    .eq("conversation_id", (conversation as { id: string }).id)
    .eq("direction", "outgoing")
    // Only what a person typed. The bot's replies already arrived in the
    // response to the message that prompted them; sending them again would
    // show the visitor every answer twice.
    .eq("sender_type", "agent")
    .order("created_at", { ascending: true })
    .limit(20);

  if (since) query = query.gt("created_at", since);

  const { data } = await query;

  return NextResponse.json(
    {
      messages: (data ?? []) as Array<{ id: string; body: string; created_at: string }>,
      handedOff: (conversation as { status: string }).status === "handed_off",
    },
    { headers }
  );
}
