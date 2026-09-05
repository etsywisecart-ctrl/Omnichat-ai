import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { syncStore } from "@/lib/stores/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Sync every connected store that has syncing switched on.
 *
 * Shared by the nightly schedule and by an owner pressing "Sync now", because
 * a store that is only synced when someone remembers is not synced — the whole
 * point is that a price changed in Shopify stops being quoted wrongly without
 * anyone doing anything.
 */
/**
 * How many shops one scheduled run will sync.
 *
 * A serverless function is killed at its timeout, so "loop over every shop"
 * works until there are enough shops to exceed it — and then it stops
 * finishing, silently, and the shops at the end of the list are simply never
 * synced. Bounded work per run, oldest-synced first, means adding customers
 * lengthens the cycle instead of breaking it.
 */
const STORES_PER_RUN = 20;

async function syncEveryStore() {
  const { data } = await supabaseAdmin
    .from("store_connections")
    .select("business_id, last_synced_at")
    .eq("sync_enabled", true)
    // Never-synced first, then whoever has waited longest. A shop cannot be
    // starved by the ordering, because syncing moves it to the back.
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(STORES_PER_RUN);

  const results = [];
  for (const row of (data ?? []) as Array<{ business_id: string }>) {
    // syncStore never throws — one unreachable store must not abandon the
    // rest of the batch.
    const result = await syncStore(row.business_id);
    results.push({
      businessId: row.business_id,
      ...(result.ok ? result.report : { error: result.error }),
    });
  }
  return results;
}

/** Whichever secret is configured; Vercel sets CRON_SECRET for its scheduler. */
function schedulerSecret(): string | undefined {
  return process.env.CRON_SECRET || process.env.CAMPAIGN_CRON_SECRET;
}

function isScheduler(request: NextRequest): boolean {
  const secret = schedulerSecret();
  if (!secret) return false;
  return (request.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

/**
 * GET /api/stores/sync — the nightly run.
 *
 * Vercel Cron sends a GET with the CRON_SECRET as a bearer token. With no
 * secret configured we cannot tell the scheduler from anyone on the internet,
 * so the route refuses rather than letting a stranger drive everyone's store
 * API quota.
 */
export async function GET(request: NextRequest) {
  if (!schedulerSecret()) {
    return NextResponse.json(
      {
        error: "not_configured",
        message:
          "Set CRON_SECRET in Vercel so scheduled syncs can be told apart from anonymous requests.",
      },
      { status: 503 }
    );
  }

  if (!isScheduler(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const results = await syncEveryStore();
  return NextResponse.json({ stores: results.length, results });
}

/**
 * POST /api/stores/sync
 *
 * Two callers, two ways of proving who they are: a signed-in owner pressing
 * "Sync now", or a scheduler holding the cron secret.
 */
export async function POST(request: NextRequest) {
  if (isScheduler(request)) {
    const results = await syncEveryStore();
    return NextResponse.json({ stores: results.length, results });
  }

  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const result = await syncStore(ctx.businessId);
  if (!result.ok) return NextResponse.json({ message: result.error }, { status: 400 });

  return NextResponse.json(result.report);
}
