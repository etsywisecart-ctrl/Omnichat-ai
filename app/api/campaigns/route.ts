import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { campaignReadiness } from "@/lib/campaigns/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/campaigns — whether this shop may broadcast, and why not.
 * POST /api/campaigns — schedule one.
 *
 * The gate is enforced here rather than only in the page, because a disabled
 * button is a suggestion. A broadcast that goes out to people who never opted
 * in cannot be recalled by fixing the UI afterwards.
 */
export async function GET(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  return NextResponse.json(await campaignReadiness(ctx.businessId));
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

  const name = String(body.name ?? "").trim();
  const templateName = String(body.templateName ?? "").trim();
  const scheduledAt = String(body.scheduledAt ?? "").trim();

  if (!name) return NextResponse.json({ message: "Give the campaign a name." }, { status: 400 });
  if (!templateName) {
    return NextResponse.json({ message: "Choose an approved template." }, { status: 400 });
  }

  const when = scheduledAt ? new Date(scheduledAt) : new Date();
  if (Number.isNaN(when.getTime())) {
    return NextResponse.json({ message: "That date isn't valid." }, { status: 400 });
  }

  // Re-checked at the moment of scheduling: readiness is a live fact, and the
  // page may have been open since before a template was revoked.
  const readiness = await campaignReadiness(ctx.businessId);
  if (!readiness.canSend) {
    const blocking = readiness.checks.filter((check) => !check.ok && check.blocking);
    return NextResponse.json(
      {
        message: `Can't schedule yet — ${blocking.map((c) => c.name).join(", ")}.`,
        checks: blocking,
      },
      { status: 409 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .insert({
      business_id: ctx.businessId,
      name,
      channel_type: "whatsapp",
      template_name: templateName,
      scheduled_at: when.toISOString(),
      status: "scheduled",
    })
    .select("id, name, scheduled_at")
    .single();

  if (error) return NextResponse.json({ message: error.message }, { status: 500 });

  return NextResponse.json({
    campaign: data,
    message: `"${name}" is scheduled for ${when.toLocaleString()}. Recipients are chosen and messages sent when it runs.`,
  });
}
