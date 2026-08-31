import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { parseCSV } from "@/lib/products/csv";

export const runtime = "nodejs";

/**
 * POST /api/products/upload
 * Import a product CSV into the signed-in user's catalog.
 *
 * Columns: name (required), price or price_cents (required), sku, currency,
 * description. The business is taken from the caller's session — never from
 * the request body — so one tenant can't write into another's catalog.
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
    const { products, skipped } = parseCSV(csv);

    if (products.length === 0) {
      return NextResponse.json(
        {
          error: "no_valid_rows",
          message:
            "No usable rows found. Each row needs a name and a price (or price_cents).",
        },
        { status: 400 }
      );
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
          is_active: true,
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

    return NextResponse.json({
      success: true,
      inserted: inserted?.length ?? 0,
      skipped: skipped + (products.length - unique.length),
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
