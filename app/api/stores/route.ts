import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { normaliseStoreUrl, syncStore, type StoreConnection } from "@/lib/stores/sync";
import type { StoreProvider } from "@/lib/stores/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The shop's connection to its own Shopify or WooCommerce store.
 *
 * Credentials only ever travel inwards. They are written with the service-role
 * key into a table that has RLS on and no policy, so nothing holding the anon
 * key — which is every dashboard in a browser — can read them back. GET
 * answers with a masked summary instead, which is enough to see that the right
 * store is connected without handing the token to the page.
 */

/** `shpat_ab…7f9c` — enough to recognise, useless to reuse. */
function masked(secret: string | null | undefined): string | null {
  if (!secret) return null;
  if (secret.length < 12) return "(too short — check it was copied in full)";
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}

export async function GET(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { data } = await supabaseAdmin
    .from("store_connections")
    .select("*")
    .eq("business_id", ctx.businessId)
    .maybeSingle();

  const connection = data as StoreConnection | null;
  if (!connection) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: true,
    provider: connection.provider,
    storeUrl: connection.store_url,
    credential: masked(connection.access_token ?? connection.consumer_key),
    syncEnabled: connection.sync_enabled,
    lastSyncedAt: connection.last_synced_at,
    lastStatus: connection.last_status,
    lastError: connection.last_error,
    lastImported: connection.last_imported,
    lastDeactivated: connection.last_deactivated,
  });
}

/**
 * Connect a store, then immediately sync it.
 *
 * The first sync is the test: credentials that cannot read the catalog are not
 * connected, they only look connected until someone asks the agent a question.
 */
export async function POST(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "Send JSON." }, { status: 400 });
  }

  const provider = String(body.provider ?? "") as StoreProvider;
  if (provider !== "shopify" && provider !== "woocommerce") {
    return NextResponse.json({ message: "Choose Shopify or WooCommerce." }, { status: 400 });
  }

  let storeUrl: string;
  try {
    storeUrl = normaliseStoreUrl(provider, String(body.storeUrl ?? ""));
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "That store address isn't valid." },
      { status: 400 }
    );
  }

  const accessToken = String(body.accessToken ?? "").trim();
  const consumerKey = String(body.consumerKey ?? "").trim();
  const consumerSecret = String(body.consumerSecret ?? "").trim();

  if (provider === "shopify" && !accessToken) {
    return NextResponse.json({ message: "Paste your Admin API access token." }, { status: 400 });
  }
  if (provider === "woocommerce" && (!consumerKey || !consumerSecret)) {
    return NextResponse.json(
      { message: "Paste both the consumer key and the consumer secret." },
      { status: 400 }
    );
  }

  const { error: saveError } = await supabaseAdmin.from("store_connections").upsert(
    {
      business_id: ctx.businessId,
      provider,
      store_url: storeUrl,
      access_token: provider === "shopify" ? accessToken : null,
      consumer_key: provider === "woocommerce" ? consumerKey : null,
      consumer_secret: provider === "woocommerce" ? consumerSecret : null,
      sync_enabled: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "business_id" }
  );

  if (saveError) {
    // The table is created by a migration the owner runs once, so name that
    // rather than reporting a database error they cannot act on.
    const missing = /relation .*store_connections.* does not exist/i.test(saveError.message);
    return NextResponse.json(
      {
        message: missing
          ? "The store_connections table doesn't exist yet. Run supabase/migrations/002_store_connections.sql in Supabase → SQL Editor, then connect again."
          : saveError.message,
      },
      { status: missing ? 503 : 500 }
    );
  }

  const result = await syncStore(ctx.businessId);
  if (!result.ok) {
    return NextResponse.json({ connected: true, synced: false, message: result.error }, { status: 200 });
  }

  return NextResponse.json({ connected: true, synced: true, ...result.report });
}

/** Disconnect. The catalog stays: those products are the shop's, not ours. */
export async function DELETE(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { error } = await supabaseAdmin
    .from("store_connections")
    .delete()
    .eq("business_id", ctx.businessId);

  if (error) return NextResponse.json({ message: error.message }, { status: 500 });
  return NextResponse.json({ connected: false });
}
