import { supabaseAdmin } from "@/lib/supabase/server";
import { fetchShopifyProducts, normaliseShopifyDomain } from "./shopify";
import { fetchWooProducts, normaliseWooUrl } from "./woocommerce";
import type { StoreProduct, StoreProvider } from "./types";

/**
 * Pull a shop's catalog from its store and mirror it into the agent's catalog.
 *
 * The difference from a CSV upload is deactivation. An upload can only add and
 * update, so a product deleted from the store stays live in the catalog and
 * the agent keeps offering it — quoting a price for something nobody can buy.
 * A sync knows the whole catalog, so it can retire what is no longer there.
 */

export interface StoreConnection {
  id: string;
  business_id: string;
  provider: StoreProvider;
  store_url: string;
  access_token: string | null;
  consumer_key: string | null;
  consumer_secret: string | null;
  sync_enabled: boolean;
  last_synced_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_imported: number;
  last_deactivated: number;
}

export interface SyncReport {
  imported: number;
  deactivated: number;
  skipped: number;
}

/** Fetch the catalog for whichever store is connected. */
export async function fetchFromStore(connection: StoreConnection) {
  if (connection.provider === "shopify") {
    if (!connection.access_token) throw new Error("This Shopify connection has no access token.");
    return fetchShopifyProducts({
      storeUrl: connection.store_url,
      accessToken: connection.access_token,
    });
  }

  if (!connection.consumer_key || !connection.consumer_secret) {
    throw new Error("This WooCommerce connection has no key and secret.");
  }
  return fetchWooProducts({
    storeUrl: connection.store_url,
    consumerKey: connection.consumer_key,
    consumerSecret: connection.consumer_secret,
  });
}

/** Normalise whatever the owner pasted into the address the API expects. */
export function normaliseStoreUrl(provider: StoreProvider, raw: string): string {
  return provider === "shopify" ? normaliseShopifyDomain(raw) : normaliseWooUrl(raw);
}

/**
 * Two products in one store can carry the same SKU, and the catalog's unique
 * index would reject the batch. Suffix the later one from its own name, so the
 * code is stable across syncs and updates that row rather than adding another.
 */
function withDistinctSkus(products: StoreProduct[]): StoreProduct[] {
  const bySku = new Map<string, StoreProduct>();

  for (const product of products) {
    const held = bySku.get(product.sku);
    if (!held || held.name === product.name) {
      bySku.set(product.sku, product);
      continue;
    }
    const slug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const distinct = `${product.sku}-${slug}`.slice(0, 120);
    bySku.set(distinct, { ...product, sku: distinct });
  }

  return [...bySku.values()];
}

/**
 * Run one sync for a business.
 *
 * Never throws: a store that is down, a revoked token or a changed password
 * must leave the existing catalog intact and record why, rather than emptying
 * the catalog the agent sells from.
 */
export async function syncStore(businessId: string): Promise<
  { ok: true; report: SyncReport } | { ok: false; error: string }
> {
  const { data } = await supabaseAdmin
    .from("store_connections")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();

  const connection = data as StoreConnection | null;
  if (!connection) return { ok: false, error: "No store is connected." };

  const finish = async (status: string, error: string | null, report: SyncReport) => {
    await supabaseAdmin
      .from("store_connections")
      .update({
        last_synced_at: new Date().toISOString(),
        last_status: status,
        last_error: error,
        last_imported: report.imported,
        last_deactivated: report.deactivated,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);
  };

  const empty: SyncReport = { imported: 0, deactivated: 0, skipped: 0 };

  try {
    const { products, skipped } = await fetchFromStore(connection);

    // A store that answers with nothing is far more likely to be a permissions
    // problem than a shop that deleted its entire catalog. Deactivating
    // everything on that reading would take the agent off the air.
    if (products.length === 0) {
      const error =
        "The store returned no products. Nothing was changed — check the connection has permission to read products.";
      await finish("failed", error, empty);
      return { ok: false, error };
    }

    const unique = withDistinctSkus(products);
    const now = new Date().toISOString();

    const { error: upsertError } = await supabaseAdmin.from("products").upsert(
      unique.map((p) => ({
        business_id: businessId,
        name: p.name,
        sku: p.sku,
        description: p.description ?? null,
        price_cents: p.price_cents,
        currency: p.currency,
        source: "api",
        is_active: p.is_active,
        updated_at: now,
      })),
      { onConflict: "business_id,sku", ignoreDuplicates: false }
    );

    if (upsertError) throw new Error(upsertError.message);

    // ---- Retire what the store no longer sells ----
    //
    // Scoped to source = 'api': products added by CSV or by hand are the
    // owner's own and are not this store's to switch off.
    const liveSkus = new Set(unique.map((p) => p.sku));
    const { data: existing } = await supabaseAdmin
      .from("products")
      .select("id, sku")
      .eq("business_id", businessId)
      .eq("source", "api")
      .eq("is_active", true);

    const stale = (existing ?? []).filter(
      (row: { sku: string }) => !liveSkus.has(row.sku)
    );

    if (stale.length > 0) {
      await supabaseAdmin
        .from("products")
        .update({ is_active: false, updated_at: now })
        .in(
          "id",
          stale.map((row: { id: string }) => row.id)
        );
    }

    const report: SyncReport = {
      imported: unique.length,
      deactivated: stale.length,
      skipped,
    };
    await finish("ok", null, report);
    return { ok: true, report };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The sync failed.";
    console.error("store sync failed:", message);
    await finish("failed", message, empty);
    return { ok: false, error: message };
  }
}
