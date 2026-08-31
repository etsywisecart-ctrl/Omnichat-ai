import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["bot_active", "handed_off", "closed"] as const;
type Status = (typeof STATUSES)[number];

/**
 * PATCH /api/dashboard/conversation/:id/status
 *
 * Move a conversation between "the bot is handling it", "a human has it" and
 * "done". This is what makes the Inbox badge actionable — before, the count of
 * conversations needing a human could go up but never down.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { supabase, businessId } = ctx;
  const { id } = await params;

  try {
    const body = (await request.json().catch(() => null)) as { status?: string } | null;
    const status = body?.status as Status | undefined;

    if (!status || !STATUSES.includes(status)) {
      return NextResponse.json(
        { error: "bad_status", message: `Status must be one of: ${STATUSES.join(", ")}.` },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("conversations")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("business_id", businessId)
      .select("id, status")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { error: "not_found", message: "Conversation not found." },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, conversation: data });
  } catch (error) {
    console.error("status update error:", error);
    return NextResponse.json(
      { error: "server_error", message: "Couldn't update the conversation." },
      { status: 500 }
    );
  }
}
