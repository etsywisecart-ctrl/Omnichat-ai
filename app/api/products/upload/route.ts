import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { parseCSV } from "@/lib/products/csv";

export const runtime = "nodejs";

/**
 * POST /api/products/upload
 * Import a product CSV into the signed-in user's catalog.
 *
 * Columns: name (required), price or price_cents (required), sku, currency,
 * description — matched against the titles real stores export, so a Shopify or
 * WooCommerce file imports as downloaded. The business is taken from the
 * caller's session — never from the request body — so one tenant can't write
 * into another's catalog.
 */
export async function POST(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || typeof file === "string") {
      return NextResponse.json(
        { error: "no_file", message: "Attach a CSV file to upload." },
        { status: 400 }
      );
    }

    const csv = await file.text();
    const { products, skipped, skippedNoName, skippedNoPrice, headers, missing } = parseCSV(csv);

    if (products.length === 0) {
      // Name the columns the file actually has. "No usable rows" alone sends
      // someone hunting through a spreadsheet for a fault we can already see.
      const seen = headers.length ? headers.slice(0, 12).join(", ") : "(none)";
      const message = missing.length
        ? `Couldn't find a ${missing.join(" or ")} column. The file's columns are: ${seen}. ` +
          `Rename the one holding the ${missing[0]} to "${missing[0]}" and upload again.`
        : `Found the right columns, but no row had both a name and a price. ` +
          `${skippedNoName} row(s) had no name and ${skippedNoPrice} had no price.`;

      return NextResponse.json({ error: "no_valid_rows", message }, { status: 400 });
    }

    // Last row wins on a repeated SKU. Without this, Postgres rejects the whole
    // batch with "ON CONFLICT DO UPDATE command cannot affect row a second time".
    const bySku = new Map<string, (typeof products)[number]>();
    for (const p of products) bySku.set(p.sku, p);
    const unique = [...bySku.values()];

    const { data: inserted, error } = await ctx.supabase
      .from("products")
      .upsert(
        unique.map((p) => ({
          business_id: ctx.businessId,
          name: p.name,
          sku: p.sku,
          description: p.description ?? null,
          price_cents: p.price_cents,
          currency: p.currency,
          source: "csv",
          // A draft or unpublished product must not be quoted to a customer.
          is_active: p.is_active,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "business_id,sku", ignoreDuplicates: false }
      )
      .select();

    if (error) {
      console.error("CSV upload insert failed:", error);
      return NextResponse.json(
        { error: "insert_failed", message: error.message },
        { status: 500 }
      );
    }

    const imported = inserted?.length ?? 0;

    return NextResponse.json({
      success: true,
      // Both spellings: the dashboard reads `imported`, and returning only
      // `inserted` is why the success toast said "Imported undefined products".
      imported,
      inserted: imported,
      skipped: skipped + (products.length - unique.length),
      skippedNoName,
      skippedNoPrice,
      products: inserted,
    });
  } catch (error) {
    console.error("CSV upload error:", error);
    return NextResponse.json(
      { error: "server_error", message: "Couldn't read that CSV file." },
      { status: 500 }
    );
  }
}
