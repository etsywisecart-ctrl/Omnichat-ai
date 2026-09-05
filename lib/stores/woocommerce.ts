import { plainText } from "@/lib/products/csv";
import { assertPublicUrl, type StoreFetchResult, type StoreProduct } from "./types";

/**
 * Read a WooCommerce catalog through the REST API.
 *
 * WooCommerce issues a read-only key/secret pair from the store's own admin,
 * so a shop owner can connect without installing anything or granting write
 * access to their storefront.
 */

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

interface WooProduct {
  name?: string;
  sku?: string;
  price?: string;
  regular_price?: string;
  description?: string;
  short_description?: string;
  status?: string;
  catalog_visibility?: string;
  id?: number;
}

/** https://yourshop.com, with any trailing path or slash removed. */
export function normaliseWooUrl(raw: string): string {
  const trimmed = (raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Enter your store's web address.");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = assertPublicUrl(withScheme);
  return `${url.protocol}//${url.host}`;
}

async function wooError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");

  if (response.status === 401 || response.status === 403) {
    return "WooCommerce rejected the key and secret. Regenerate them under WooCommerce → Settings → Advanced → REST API, with Read permission.";
  }
  if (response.status === 404) {
    return "No WooCommerce API at that address. Check the store URL, and that WooCommerce is installed and permalinks are not set to Plain.";
  }
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) return `WooCommerce says: ${parsed.message}`;
  } catch {
    /* fall through */
  }
  return `WooCommerce returned ${response.status}. ${body.slice(0, 200)}`.trim();
}

export async function fetchWooProducts({
  storeUrl,
  consumerKey,
  consumerSecret,
}: {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}): Promise<StoreFetchResult> {
  const base = normaliseWooUrl(storeUrl);
  const products: StoreProduct[] = [];
  let skipped = 0;

  // Basic auth over HTTPS is WooCommerce's documented method; the key and
  // secret never appear in the URL, where they would land in access logs.
  const authorization = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetch(
      `${base}/wp-json/wc/v3/products?per_page=${PAGE_SIZE}&page=${page}&status=any`,
      { headers: { Authorization: authorization, Accept: "application/json" } }
    );

    if (!response.ok) throw new Error(await wooError(response));

    const batch = (await response.json()) as WooProduct[];
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const item of batch) {
      const name = (item.name ?? "").trim();
      // regular_price over price: `price` reflects an active sale, and a
      // discount that lapses would leave the agent quoting a stale figure.
      const raw = item.regular_price || item.price || "";
      const amount = Number.parseFloat(raw.replace(/[^0-9.]/g, ""));

      if (!name || !Number.isFinite(amount)) {
        skipped++;
        continue;
      }

      products.push({
        name,
        sku: (item.sku ?? "").trim() || `woo-${item.id ?? name}`.slice(0, 100),
        price_cents: Math.round(amount * 100),
        currency: "USD",
        description:
          plainText(item.short_description ?? "") || plainText(item.description ?? "") || undefined,
        is_active:
          (item.status ?? "publish").toLowerCase() === "publish" &&
          (item.catalog_visibility ?? "visible").toLowerCase() !== "hidden",
      });
    }

    if (batch.length < PAGE_SIZE) break;
  }

  return { products, skipped };
}
