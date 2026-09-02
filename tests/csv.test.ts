import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitCSVLine, parseMoney, skuFromName, parseCSV } from "@/lib/products/csv";

const helpers = { splitCSVLine, parseMoney, skuFromName };

describe("CSV field splitting", () => {
  test("a comma inside quotes stays in its own field", () => {
    // The original parser split on every comma, shifting every later column.
    const row = helpers.splitCSVLine('Espresso Cup Set,CUP-005,32.00,USD,"Set of four cups, 80ml each"');
    assert.equal(row.length, 5);
    assert.equal(row[4], "Set of four cups, 80ml each");
  });

  test("doubled quotes are an escaped quote", () => {
    assert.equal(helpers.splitCSVLine('a,"say ""hi""",b')[1], 'say "hi"');
  });

  test("empty trailing fields are preserved", () => {
    assert.deepEqual(helpers.splitCSVLine("a,b,"), ["a", "b", ""]);
  });
});

describe("price parsing", () => {
  test("reads major units, never guessing cents", () => {
    // The old heuristic was `n > 100 ? cents : dollars`, which stored a
    // $150.00 product as $1.50.
    assert.equal(helpers.parseMoney("150.00"), 15000);
    assert.equal(helpers.parseMoney("64.00"), 6400);
    assert.equal(helpers.parseMoney("18"), 1800);
    assert.equal(helpers.parseMoney("9.75"), 975);
  });

  test("tolerates currency symbols and thousands separators", () => {
    assert.equal(helpers.parseMoney("$1,299.00"), 129900);
  });

  test("rejects junk rather than storing zero", () => {
    assert.equal(helpers.parseMoney(""), null);
    assert.equal(helpers.parseMoney("free"), null);
  });
});

describe("SKU generation", () => {
  test("derives a slug so every row has a conflict key", () => {
    // A blank sku would collide with every other blank one under the unique
    // index that ON CONFLICT needs.
    assert.equal(helpers.skuFromName("Blue Ceramic Mug"), "blue-ceramic-mug");
    assert.equal(helpers.skuFromName("Café  Crème!"), "caf-cr-me");
  });

  test("is stable, so re-importing updates instead of duplicating", () => {
    assert.equal(helpers.skuFromName("Linen Tea Towel"), helpers.skuFromName("Linen Tea Towel"));
  });

  test("still yields something for a name with no usable characters", () => {
    assert.match(helpers.skuFromName("!!!"), /^item-/);
  });
});

describe("end-to-end parse", () => {
  test("reads a realistic catalog correctly", () => {
    const csv = [
      "name,sku,price,currency,description",
      "Blue Ceramic Mug,MUG-001,18.00,USD,Handmade matte blue mug",
      "Cast Iron Skillet,PAN-003,64.00,USD,Pre-seasoned 26cm skillet",
      'Espresso Cup Set,CUP-005,32.00,USD,"Set of four cups, 80ml each"',
      "No Price Row,X-1,,USD,should be skipped",
    ].join("\n");

    const { products, skipped } = parseCSV(csv);

    assert.equal(products.length, 3);
    assert.equal(skipped, 1, "the row without a price is skipped, not stored as 0");
    assert.equal(products[0].price_cents, 1800);
    assert.equal(products[1].price_cents, 6400, "$64.00 must not become $0.64");
    assert.equal(products[2].description, "Set of four cups, 80ml each");
  });

  test("fills in a SKU when the column is absent entirely", () => {
    const { products } = parseCSV("name,price\nLinen Tea Towel,12.50");
    assert.equal(products[0].sku, "linen-tea-towel");
    assert.equal(products[0].price_cents, 1250);
  });
});

describe("real store exports", () => {
  test("imports a Shopify export as downloaded", async () => {
    const { parseCSV } = await import("@/lib/products/csv");

    // Shopify's real header row and its variant/image continuation rows,
    // which repeat a product with the Title left blank.
    const csv = [
      "Handle,Title,Body (HTML),Vendor,Variant SKU,Variant Price,Status",
      'espresso-set,Espresso Cup Set,"<p>Four porcelain cups, <b>80ml</b> each</p>",Acme,ESP-4,32.00,active',
      "espresso-set,,,,ESP-6,44.00,active",
      "blue-mug,Blue Ceramic Mug,<p>Hand glazed</p>,Acme,MUG-B,18.00,active",
      "secret,Unreleased Teapot,<p>Coming soon</p>,Acme,TEA-1,55.00,draft",
    ].join("\n");

    const result = parseCSV(csv);

    // "Title" and "Variant Price" — the reason a genuine export used to fail
    // with "no usable rows" before any of this was matched.
    assert.equal(result.missing.length, 0);
    assert.equal(result.products.length, 3);

    const cups = result.products[0];
    assert.equal(cups.name, "Espresso Cup Set");
    assert.equal(cups.sku, "ESP-4");
    assert.equal(cups.price_cents, 3200);
    // Body (HTML) is literal markup; the model must not read tags aloud.
    assert.equal(cups.description, "Four porcelain cups, 80ml each");

    // A draft product must never be quoted to a customer.
    const teapot = result.products.find((p) => p.name === "Unreleased Teapot");
    assert.equal(teapot?.is_active, false);
    assert.equal(cups.is_active, true);

    // The blank-title variant row is a continuation, not a product.
    assert.equal(result.skippedNoName, 1);
  });

  test("imports a WooCommerce export as downloaded", async () => {
    const { parseCSV } = await import("@/lib/products/csv");

    const csv = [
      "ID,Type,SKU,Name,Published,Short description,Regular price,Sale price",
      "12,simple,BALM-W,Beeswax Wood Balm,1,Walnut scented,9.75,8.00",
      "13,simple,MUG-B,Blue Ceramic Mug,-1,Hand glazed,18.00,",
    ].join("\n");

    const result = parseCSV(csv);

    assert.equal(result.missing.length, 0);
    assert.equal(result.products.length, 2);
    assert.equal(result.products[0].name, "Beeswax Wood Balm");
    // "Regular price" must win over "Sale price" — quoting a lapsed discount
    // to every customer would be worse than quoting nothing.
    assert.equal(result.products[0].price_cents, 975);
    // Published = -1 is WooCommerce's draft.
    assert.equal(result.products[1].is_active, false);
  });

  test("reports the columns it actually found when nothing matches", async () => {
    const { parseCSV } = await import("@/lib/products/csv");

    const result = parseCSV("Item,Cost\nMug,18.00");

    assert.deepEqual(result.products, []);
    assert.deepEqual(result.missing, ["name", "price"]);
    // The upload error quotes these back, so a mismatch is shown rather than
    // left for someone to hunt through a spreadsheet for.
    assert.deepEqual(result.headers, ["Item", "Cost"]);
  });

  test("still accepts our own documented column names", async () => {
    const { parseCSV } = await import("@/lib/products/csv");

    const result = parseCSV("name,sku,price,currency,description\nMug,MUG-1,18.00,EUR,Blue");

    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].currency, "EUR");
    assert.equal(result.products[0].is_active, true);
  });
});
