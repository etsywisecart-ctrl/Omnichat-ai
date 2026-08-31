import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Escape PostgREST filter metacharacters so a search term can't inject clauses. */
function sanitize(term: string): string {
  return term.replace(/[(),*"\\]/g, " ").trim();
}

/**
 * GET /api/dashboard/conversations?limit=&search=
 * The Inbox list, newest activity first, scoped to the caller's business.
 */
export async function GET(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { supabase, businessId } = ctx;
  const { searchParams } = new URL(request.url);

  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1), 100);
  const search = sanitize(searchParams.get("search") ?? "");

  try {
    let query = supabase
      .from("conversations")
      .select("*", { count: "exact" })
      .eq("business_id", businessId)
      .order("last_message_at", { ascending: false })
      .limit(limit);

    if (search) {
      query = query.or(
        `customer_name.ilike.%${search}%,customer_identifier.ilike.%${search}%,last_message_preview.ilike.%${search}%`
      );
    }

    const { data, count, error } = await query;
    if (error) throw error;

    return NextResponse.json({
      conversations: data ?? [],
      total: count ?? data?.length ?? 0,
    });
  } catch (error) {
    console.error("dashboard/conversations error:", error);
    return NextResponse.json(
      { error: "server_error", message: "Couldn't load conversations." },
      { status: 500 }
    );
  }
}
