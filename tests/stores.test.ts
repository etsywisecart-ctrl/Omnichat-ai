import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { assertPublicUrl } from "@/lib/stores/types";
import { normaliseShopifyDomain, fetchShopifyProducts } from "@/lib/stores/shopify";
import { normaliseWooUrl, fetchWooProducts } from "@/lib/stores/woocommerce";

const realFetch = globalThis.fetch;

describe("store addresses", () => {
  test("refuses addresses that only resolve inside our own network", () => {
    // The store URL is typed by a user and then fetched by our server, which
    // is how a settings field becomes a probe of private infrastructure.
    for (const address of [
      "http://localhost:8080",
      "http://127.0.0.1/wp-json",
      "https://10.0.0.5",
      "https://192.168.1.1",
      "https://169.254.169.254/latest/meta-data",
      "https://172.16.0.9",
      "https://printer.local",
    ]) {
      assert.throws(() => assertPublicUrl(address), /not reachable from the internet/, address);
    }
  });

  test("accepts a real store address", () => {
    assert.equal(assertPublicUrl("https://shop.com/").hostname, "shop.com");
  });

  test("tidies however a Shopify domain was pasted", () => {
    assert.equal(normaliseShopifyDomain("https://MyShop.myshopify.com/admin"), "myshop.myshopify.com");
    assert.equal(normaliseShopifyDomain(" myshop.myshopify.com "), "myshop.myshopify.com");
    // A custom domain does not reach the Admin API, and saying so beats a 404.
    assert.throws(() => normaliseShopifyDomain("myshop.com"), /myshopify\.com/);
  });

  test("keeps only the origin of a WooCommerce address", () => {
    assert.equal(normaliseWooUrl("shop.com"), "https://shop.com");
    assert.equal(normaliseWooUrl("https://shop.com/wp-admin/"), "https://shop.com");
  });
});

describe("reading a Shopify catalog", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("imports products, follows pages, and marks drafts inactive", async () => {
    const pages = [
      {
        link: '<https://s.myshopify.com/admin/api/2024-10/products.json?page_info=NEXT>; rel="next"',
        body: {
          products: [
            {
              title: "Skeleton Watch",
              body_html: "<p>Precision &amp; elegance</p>",
              handle: "skeleton",
              status: "active",
              variants: [{ sku: "SKEL-1", price: "4099.00" }],
            },
          ],
        },
      },
      {
        link: "",
        body: {
          products: [
            {
              title: "Unreleased Watch",
              body_html: "",
              handle: "unreleased",
              status: "draft",
              variants: [{ sku: "", price: "1000.00" }],
            },
            { title: "", handle: "broken", status: "active", variants: [] },
          ],
        },
      },
    ];

    let call = 0;
    globalThis.fetch = (async () => {
      const page = pages[Math.min(call++, pages.length - 1)];
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "link" ? page.link : null) },
        json: async () => page.body,
      };
    }) as unknown as typeof fetch;

    const result = await fetchShopifyProducts({
      storeUrl: "s.myshopify.com",
      accessToken: "shpat_test",
    });

    assert.equal(call, 2, "must follow the Link header to the second page");
    assert.equal(result.products.length, 2);
    assert.equal(result.products[0].price_cents, 409900);
    // body_html is markup; the agent must not read tags aloud.
    assert.equal(result.products[0].description, "Precision & elegance");
    // A draft product exists in the admin but is not for sale.
    assert.equal(result.products[1].is_active, false);
    // No SKU: one is derived so the row still has a stable identity.
    assert.equal(result.products[1].sku, "shopify-unreleased");
    assert.equal(result.skipped, 1, "a product with no price is not a product");
  });

  test("explains a rejected token instead of repeating the status code", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => "{}",
    })) as unknown as typeof fetch;

    await assert.rejects(
      fetchShopifyProducts({ storeUrl: "s.myshopify.com", accessToken: "bad" }),
      /rejected the access token[\s\S]*read_products/
    );
  });
});

describe("reading a WooCommerce catalog", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("prefers the regular price over an active sale price", async () => {
    globalThis.fetch = (async (url: unknown, init: { headers: Record<string, string> }) => {
      // The key and secret must travel in the header, never the query string,
      // where they would be written into every access log on the way.
      assert.match(init.headers.Authorization, /^Basic /);
      assert.doesNotMatch(String(url), /ck_|cs_/);

      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 1,
            name: "Wood Balm",
            sku: "BALM-W",
            regular_price: "9.75",
            price: "8.00",
            short_description: "<p>Walnut scented</p>",
            status: "publish",
          },
          { id: 2, name: "Hidden Mug", sku: "MUG", regular_price: "18.00", status: "draft" },
        ],
      };
    }) as unknown as typeof fetch;

    const result = await fetchWooProducts({
      storeUrl: "https://shop.com",
      consumerKey: "ck_1",
      consumerSecret: "cs_1",
    });

    assert.equal(result.products.length, 2);
    // A discount that lapses would leave the agent quoting a stale figure.
    assert.equal(result.products[0].price_cents, 975);
    assert.equal(result.products[0].description, "Walnut scented");
    assert.equal(result.products[1].is_active, false);
  });
});
