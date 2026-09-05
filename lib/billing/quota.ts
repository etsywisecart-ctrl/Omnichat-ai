import { supabaseAdmin } from "@/lib/supabase/server";

/**
 * How much of its allowance a shop has used this month.
 *
 * Every shop on this deployment answers through one Gemini key with one
 * quota. Without a per-shop ceiling the busiest shop simply takes it, and the
 * others go quiet with no explanation — which is fine while there is one
 * customer and untenable the moment there are two.
 *
 * Counted from the messages already stored rather than a separate meter: a
 * counter can drift from what was actually sent, and the thing being sold is
 * the replies, not the counter.
 */

export interface Usage {
  used: number;
  limit: number;
  remaining: number;
  exceeded: boolean;
  /** Start of the current calendar month, when the count resets. */
  since: string;
}

/** A shop with no plan row behaves as the free plan rather than as unlimited. */
const DEFAULT_LIMIT = 500;

function startOfMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function replyUsage(businessId: string): Promise<Usage> {
  const since = startOfMonth();

  const [business, replies] = await Promise.all([
    supabaseAdmin
      .from("businesses")
      .select("monthly_reply_limit")
      .eq("id", businessId)
      .maybeSingle(),
    supabaseAdmin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("sender_type", "bot")
      .gte("created_at", since),
  ]);

  // A missing column means the limits migration has not been run. Treat that
  // as the default plan rather than as no limit — failing open on a shared
  // quota is how one shop silently drains everyone else's.
  const limit =
    (business.data as { monthly_reply_limit?: number } | null)?.monthly_reply_limit ??
    DEFAULT_LIMIT;

  const used = replies.count ?? 0;

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    exceeded: used >= limit,
    since,
  };
}

/** The sentence a customer sees when a shop has run out for the month. */
export const QUOTA_MESSAGE =
  "This shop's assistant has reached its monthly reply limit. Please leave your question and someone will get back to you.";
