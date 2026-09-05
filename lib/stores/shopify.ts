import { plainText } from "@/lib/products/csv";
import { assertPublicUrl, type StoreFetchResult, type StoreProduct } from "./types";

/**
 * Read a Shopify catalog through the Admin API.
 *
 * Uses a custom-app access token rather than OAuth: a shop owner creates one
 * in their own admin in about two minutes, where a public app would mean a
 * Partner account and an app review before they could see their own products.
 */

/** Pinned: Shopify removes an API version roughly a year after release. */
const API_VERSION = "2024-10";

/** Shopify's maximum, and the difference between 1 request and 10. */
const PAGE_SIZE = 250;

/** A runaway catalog should not become an unbounded loop. */
const MAX_PAGES = 40;

interface ShopifyVariant {
  sku?: string | null;
  price?: string | null;
}

interface ShopifyProduct {
  title?: string;
  body_html?: string | null;
  handle?: string;
  status?: string;
  variants?: ShopifyVariant[];
}

/** yourshop.myshopify.com, however the owner pasted it. */
export function normaliseShopifyDomain(raw: string): string {
  const trimmed = (raw || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!trimmed) throw new Error("Enter your .myshopify.com address.");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(trimmed)) {
    throw new Error(
      `"${trimmed}" doesn't look like a Shopify address. It should end in .myshopify.com — find it in Settings → Domains.`
    );
  }
  return trimmed.toLowerCase();
}

/** Turn Shopify's error body into something worth showing a shop owner. */
async function shopifyError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    return "Shopify rejected the access token. Check it was copied in full, and that the app has read_products access.";
  }
  if (response.status === 404) {
    return "Shopify has no store at that address.";
  }
  try {
    const parsed = JSON.parse(body) as { errors?: unknown };
    if (parsed.errors) return `Shopify says: ${JSON.stringify(parsed.errors)}`;
  } catch {
    /* fall through to the raw text */
  }
  return `Shopify returned ${response.status}. ${body.slice(0, 200)}`.trim();
}

/** The next page's URL, from the Link header Shopify paginates with. */
function nextPageUrl(response: Response): string | null {
  const link = response.headers.get("link") ?? "";
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

export async function fetchShopifyProducts({
  storeUrl,
  accessToken,
}: {
  storeUrl: string;
  accessToken: string;
}): Promise<StoreFetchResult> {
  const domain = normaliseShopifyDomain(storeUrl);
  assertPublicUrl(`https://${domain}`);

  const products: StoreProduct[] = [];
  let skipped = 0;
  let url: string | null =
    `https://${domain}/admin/api/${API_VERSION}/products.json?limit=${PAGE_SIZE}`;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const response: Response = await fetch(url, {
      headers: { "X-Shopify-Access-Token": accessToken, Accept: "application/json" },
    });

    if (!response.ok) throw new Error(await shopifyError(response));

    const body = (await response.json()) as { products?: ShopifyProduct[] };

    for (const item of body.products ?? []) {
      const name = (item.title ?? "").trim();
      // The first variant carries the price a customer is quoted. Variants
      // become separate catalog entries only if they are separate products,
      // which for a chat agent quoting one price they are not.
      const variant = item.variants?.[0];
      const price = Number.parseFloat((variant?.price ?? "").replace(/[^0-9.]/g, ""));

      if (!name || !Number.isFinite(price)) {
        skipped++;
        continue;
      }

      products.push({
        name,
        sku: (variant?.sku ?? "").trim() || `shopify-${item.handle ?? name}`.slice(0, 100),
        price_cents: Math.round(price * 100),
        currency: "USD",
        description: plainText(item.body_html ?? "") || undefined,
        // Draft and archived products exist in the admin but are not for sale.
        is_active: (item.status ?? "active").toLowerCase() === "active",
      });
    }

    url = nextPageUrl(response);
  }

  return { products, skipped };
}
