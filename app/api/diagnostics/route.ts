import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { supabaseAdmin, serviceRoleKeyProblem } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics
 *
 * Answers "is this thing configured correctly?" with facts instead of guesses.
 *
 * Every check reports what actually happened when the app tried to use a key —
 * not merely whether the variable exists. A present-but-wrong key is the case
 * that wastes the most time, and it looks identical to a correct one from the
 * outside.
 *
 * Requires a signed-in agent: it reveals which services are configured, which
 * is not something to hand to anonymous callers. Values are never returned —
 * only a masked shape, so a typo is visible without exposing the secret.
 */

/** `sb_secret_abc…xyz` — enough to spot a wrong key, useless to steal. */
function shape(value: string | undefined): string {
  if (!value) return "(not set)";
  if (value.length < 12) return `(suspiciously short: ${value.length} chars)`;
  return `${value.slice(0, 11)}…${value.slice(-4)} · ${value.length} chars`;
}

export async function GET(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const env = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };

  const checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
    fix?: string;
  }> = [];

  // ---- Supabase URL ----
  checks.push({
    name: "Supabase URL",
    ok: Boolean(env.NEXT_PUBLIC_SUPABASE_URL?.includes(".supabase.co")),
    detail: env.NEXT_PUBLIC_SUPABASE_URL ?? "(not set)",
    fix: "Supabase → Project Settings → API → Project URL",
  });

  // ---- Service-role key: does it actually work? ----
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const keyProblem = serviceRoleKeyProblem();
  if (keyProblem) {
    checks.push({
      name: "Supabase service-role key",
      ok: false,
      detail: serviceKey ? `${shape(serviceKey)} — ${keyProblem}` : keyProblem,
      fix: "Supabase → Project Settings → API Keys → the 'secret' row → Reveal. It starts sb_secret_.",
    });
  } else {
    const { error, count } = await supabaseAdmin
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("business_id", ctx.businessId);

    checks.push({
      name: "Supabase service-role key",
      ok: !error,
      detail: error
        ? `${shape(serviceKey)} — Supabase says: ${error.message}`
        : `Working. Can read ${count ?? 0} product(s).`,
      fix: error
        ? "Copy the 'secret' key again from Supabase → Project Settings → API Keys, then REDEPLOY."
        : undefined,
    });
  }

  // ---- Gemini: does the key actually authenticate? ----
  const geminiKey = env.GEMINI_API_KEY;
  if (!geminiKey) {
    checks.push({
      name: "Gemini API key",
      ok: false,
      detail: "Not set — the AI will fall back to a plain catalog lookup.",
      fix: "Get a free key at aistudio.google.com/apikey, add GEMINI_API_KEY in Vercel, then REDEPLOY.",
    });
  } else {
    try {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "x-goog-api-key": geminiKey },
      });
      const body = (await res.json().catch(() => ({}))) as {
        models?: Array<{ name?: string }>;
        error?: { message?: string };
      };

      checks.push({
        name: "Gemini API key",
        ok: res.ok,
        detail: res.ok
          ? `Working. ${body.models?.length ?? 0} models available.`
          : `${shape(geminiKey)} — Google says: ${body.error?.message ?? res.status}`,
        fix: res.ok ? undefined : "Create a fresh key at aistudio.google.com/apikey, then REDEPLOY.",
      });
    } catch (error) {
      checks.push({
        name: "Gemini API key",
        ok: false,
        detail: `Couldn't reach Google: ${error instanceof Error ? error.message : "unknown"}`,
      });
    }
  }

  // ---- Catalog ----
  const { count: productCount, error: productError } = await ctx.supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("business_id", ctx.businessId)
    .eq("is_active", true);

  checks.push({
    name: "Active products",
    ok: !productError && (productCount ?? 0) > 0,
    detail: productError
      ? productError.message
      : `${productCount ?? 0} active product(s) the AI can quote.`,
    fix: (productCount ?? 0) === 0 ? "Upload a CSV on the Catalog page." : undefined,
  });

  const failing = checks.filter((c) => !c.ok);

  return NextResponse.json(
    {
      healthy: failing.length === 0,
      summary: failing.length === 0
        ? "Everything is configured correctly."
        : `${failing.length} problem(s): ${failing.map((c) => c.name).join(", ")}`,
      checks,
      reminder:
        "Environment variables only reach code built AFTER they were saved. Always redeploy after changing one.",
    },
    { status: 200 }
  );
}
