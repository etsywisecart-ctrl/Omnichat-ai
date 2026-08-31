import { NextRequest, NextResponse } from "next/server";
import { generateCustomerReply } from "@/lib/ai/gemini";

export const runtime = "nodejs";

/**
 * POST /api/ai/chat
 * Chat endpoint for the "Product Sell - AI agent" widget (ChatWidget).
 *
 * Body: { business_id, message, history?, conversation_id? }
 *
 * Reliability guarantee: replies go through Gemini with multi-model fallback
 * AND a direct Supabase catalog lookup, so a question like "do you have a blue
 * ceramic mug?" always returns a real, grounded answer — even when Gemini is
 * rate-limited ("busy") or no API key is configured.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);

    const businessId: string = body?.business_id ?? body?.businessId;
    const message: string = String(body?.message ?? body?.text ?? "").trim();
    const rawHistory: Array<{ sender?: string; text?: string }> = Array.isArray(body?.history)
      ? body.history
      : [];

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const history = rawHistory
      .filter((h) => h && typeof h.text === "string" && h.text.trim())
      .map((h) => ({
        sender: h.sender === "customer" ? ("customer" as const) : ("bot" as const),
        text: h.text as string,
      }));

    const reply = await generateCustomerReply(businessId, message, history);

    return NextResponse.json({
      reply: reply.text,
      text: reply.text,
      source: reply.source,
      model: reply.model ?? null,
      toolsUsed: reply.toolsUsed,
      matchedProducts: reply.matchedProducts,
      reason: reply.reason ?? null,
    });
  } catch (error) {
    console.error("AI chat error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal error",
        reply: "Sorry, something went wrong. Please try again.",
      },
      { status: 500 }
    );
  }
}
