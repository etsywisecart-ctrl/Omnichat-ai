import type { NextRequest } from "next/server";
import { createSupabaseServerClient } from "./server";

export interface BusinessContext {
  /** Supabase client carrying the caller's JWT, so RLS scopes every query. */
  supabase: ReturnType<typeof createSupabaseServerClient>;
  businessId: string;
  userId: string;
}

/**
 * Resolve the signed-in agent and their business from the request's bearer
 * token. Returns null when the caller is anonymous, the token is invalid, or
 * the user has no agent row yet (i.e. hasn't finished onboarding).
 *
 * Every dashboard route goes through this, so a caller can only ever read the
 * business they belong to — the client never gets to name a business_id.
 */
export async function resolveBusiness(request: NextRequest): Promise<BusinessContext | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;

  const supabase = createSupabaseServerClient(token);

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user) return null;

  const { data: agent } = await supabase
    .from("agents")
    .select("business_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!agent?.business_id) return null;

  return { supabase, businessId: agent.business_id as string, userId: user.id };
}

/** Standard 401 body for an unauthenticated or un-onboarded caller. */
export const UNAUTHORIZED = {
  error: "unauthorized",
  message: "Sign in and finish onboarding to load this data.",
};
