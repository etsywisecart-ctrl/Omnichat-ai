/**
 * One product as it arrives from a store, before it becomes a catalog row.
 *
 * Deliberately the same shape the CSV importer produces: a store connection
 * and a spreadsheet are two ways of answering the same question, and the rules
 * about prices, SKUs and draft products should not differ between them.
 */
export interface StoreProduct {
  name: string;
  sku: string;
  price_cents: number;
  currency: string;
  description?: string;
  is_active: boolean;
}

export interface StoreFetchResult {
  products: StoreProduct[];
  /** Products the store returned that we could not use, and why. */
  skipped: number;
}

export type StoreProvider = "shopify" | "woocommerce";

/**
 * Refuse to fetch from an address that only means something inside our own
 * network.
 *
 * The store URL is typed by a user and then fetched by our server, which is
 * the classic way to turn a settings field into a probe of private
 * infrastructure. Public hostnames only.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid web address.`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The store address must start with https://");
  }

  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.includes(":"); // bare IPv6, including ::1

  if (isPrivate) {
    throw new Error("That address is not reachable from the internet.");
  }
  return url;
}
