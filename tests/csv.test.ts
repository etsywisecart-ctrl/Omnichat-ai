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
