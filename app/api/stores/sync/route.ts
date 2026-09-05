import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { syncStore } from "@/lib/stores/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/stores/sync
 *
 * Two callers, two ways of proving who they are: a signed-in owner pressing
 * "Sync now", or a scheduler holding CAMPAIGN_CRON_SECRET, which syncs every
 * store that has it enabled.
 */
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CAMPAIGN_CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  const isCron = Boolean(cronSecret) && authorization === `Bearer ${cronSecret}`;

  if (isCron) {
    const { data } = await supabaseAdmin
      .from("store_connections")
      .select("business_id")
      .eq("sync_enabled", true);

    const results = [];
    for (const row of (data ?? []) as Array<{ business_id: string }>) {
      const result = await syncStore(row.business_id);
      results.push({
        businessId: row.business_id,
        ...(result.ok ? result.report : { error: result.error }),
      });
    }
    return NextResponse.json({ stores: results.length, results });
  }

  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const result = await syncStore(ctx.businessId);
  if (!result.ok) return NextResponse.json({ message: result.error }, { status: 400 });

  return NextResponse.json(result.report);
}
