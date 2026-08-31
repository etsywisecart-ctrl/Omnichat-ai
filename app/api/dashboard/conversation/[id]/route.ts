import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/conversation/:id
 * One conversation plus its full message thread, oldest message first.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { supabase, businessId } = ctx;
  const { id } = await params;

  try {
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", id)
      .eq("business_id", businessId)
      .maybeSingle();

    if (convError) throw convError;
    if (!conversation) {
      return NextResponse.json(
        { error: "not_found", message: "Conversation not found." },
        { status: 404 }
      );
    }

    const { data: messages, error: msgError } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", id)
      .eq("business_id", businessId)
      .order("created_at", { ascending: true });

    if (msgError) throw msgError;

    return NextResponse.json({ conversation, messages: messages ?? [] });
  } catch (error) {
    console.error("dashboard/conversation error:", error);
    return NextResponse.json(
      { error: "server_error", message: "Couldn't load this conversation." },
      { status: 500 }
    );
  }
}
