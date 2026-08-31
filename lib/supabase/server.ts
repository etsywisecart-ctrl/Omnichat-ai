import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "https://placeholder.supabase.co";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "placeholder-anon-key";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * True when the server is running without a usable service-role key.
 *
 * A missing key used to be silently replaced with a placeholder string, so the
 * first symptom was Supabase answering "Invalid API key" from somewhere deep in
 * a webhook — which reads like a Supabase outage rather than a missing setting.
 * Naming the condition here lets callers say what is actually wrong.
 */
export const SERVICE_ROLE_KEY_MISSING = supabaseServiceRoleKey.length === 0;

/** Why the key is unusable, or null when it looks fine. Not a guarantee it works. */
export function serviceRoleKeyProblem(): string | null {
  if (SERVICE_ROLE_KEY_MISSING) {
    return "SUPABASE_SERVICE_ROLE_KEY is not set. Add it in your hosting environment and redeploy — environment variables only reach builds made after they were saved.";
  }
  if (supabaseServiceRoleKey.startsWith("sb_publishable_")) {
    return "SUPABASE_SERVICE_ROLE_KEY holds the publishable key. Copy the 'secret' key (sb_secret_…) from Supabase → Project Settings → API Keys and redeploy.";
  }
  return null;
}

// Warn once at startup rather than on every request, so the log stays readable
// but the cause is impossible to miss.
const problem = serviceRoleKeyProblem();
if (problem) console.error(`[supabase] ${problem}`);

export const supabaseAdmin = createClient<Database>(
  supabaseUrl,
  // An empty key would throw inside createClient at import time, which breaks the
  // build. A recognisable placeholder keeps the module loadable; every call site
  // that matters checks serviceRoleKeyProblem() and reports the real cause.
  supabaseServiceRoleKey || "missing-service-role-key",
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
) as any;

export function createSupabaseServerClient(accessToken?: string) {
  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : undefined,
    },
  }) as any;
}

export const supabaseServer = createSupabaseServerClient();
