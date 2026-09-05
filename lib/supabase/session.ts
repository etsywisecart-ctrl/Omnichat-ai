"use client";

import type { Session } from "@supabase/supabase-js";
import { supabase } from "./client";

/**
 * Keeping a browser session usable.
 *
 * A Supabase access token lasts an hour. The stored session outlives it, so a
 * tab left open overnight still *looks* signed in: the email is there, the
 * pages render, and then every query fails with "JWT expired". Read as data
 * that is how a shop with 89 products gets told it has no shop, and how a
 * setup form ends up refusing to submit with a message naming a token.
 *
 * So expiry is treated as something to fix rather than something to report.
 */

/** Refresh this long before expiry, so a slow request doesn't cross the line. */
const REFRESH_MARGIN_MS = 120_000;

/** Does this error mean the token, rather than the request, was the problem? */
export function isExpiredSession(error: unknown): boolean {
  const candidate = error as { message?: string; code?: string; status?: number } | null;
  if (!candidate) return false;
  if (candidate.code === "PGRST301") return true;
  if (candidate.status === 401) return true;
  return /jwt expired|invalid jwt|token is expired|jwt.*expired/i.test(candidate.message ?? "");
}

/**
 * The current session, refreshed if it is at or near expiry.
 *
 * Returns null when there is nothing to refresh from — the caller should treat
 * that as signed out, which is honest, rather than holding a session that
 * cannot authorise anything.
 */
export async function ensureFreshSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) return null;

  const expiresAt = (session.expires_at ?? 0) * 1000;
  if (expiresAt - Date.now() > REFRESH_MARGIN_MS) return session;

  const { data: refreshed, error } = await supabase.auth.refreshSession();
  if (error || !refreshed.session) {
    // The refresh token is spent too. Clear it so the app offers a sign-in
    // rather than looping on requests that can never succeed.
    await supabase.auth.signOut().catch(() => undefined);
    return null;
  }
  return refreshed.session;
}

/**
 * Run something that needs a valid token, refreshing once if the token is what
 * failed. One retry only: a second failure is not about the token.
 */
export async function withFreshSession<T>(
  run: () => Promise<{ data: T; error: unknown }>
): Promise<{ data: T; error: unknown }> {
  const first = await run();
  if (!isExpiredSession(first.error)) return first;

  const session = await ensureFreshSession();
  if (!session) return first;

  return run();
}

/** The signed-in access token, refreshed if needed. Throws if signed out. */
export async function freshAccessToken(): Promise<string> {
  const session = await ensureFreshSession();
  if (!session) throw new Error("Your sign-in has expired. Sign in again to continue.");
  return session.access_token;
}
