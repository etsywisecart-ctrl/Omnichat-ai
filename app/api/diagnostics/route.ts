import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { supabaseAdmin, serviceRoleKeyProblem } from "@/lib/supabase/server";
import { GEMINI_MODELS } from "@/lib/ai/gemini";

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
        models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
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

      // ---- Do the models we actually call exist on this key? ----
      //
      // "50 models available" says nothing about whether gemini-2.5-flash is
      // one of them. A retired or misspelled model name 404s on every single
      // request while the key above tests perfectly, so this is the one check
      // that catches the most confusing failure this app has.
      if (res.ok) {
        const available = new Set(
          (body.models ?? [])
            .map((m) => (m.name ?? "").replace(/^models\//, ""))
            .filter(Boolean)
        );
        // An older key listing may omit the field entirely; only trust it when
        // at least one model declares it, so we never invent a failure.
        const declaresMethods = (body.models ?? []).some((m) =>
          Array.isArray(m.supportedGenerationMethods)
        );
        const canGenerate = new Set(
          (body.models ?? [])
            .filter(
              (m) =>
                !declaresMethods ||
                (m.supportedGenerationMethods ?? []).includes("generateContent")
            )
            .map((m) => (m.name ?? "").replace(/^models\//, ""))
            .filter(Boolean)
        );

        const usable = GEMINI_MODELS.filter((m) => canGenerate.has(m));
        const missing = GEMINI_MODELS.filter((m) => !available.has(m));
        const noGenerate = GEMINI_MODELS.filter(
          (m) => available.has(m) && !canGenerate.has(m)
        );

        const problems = [
          missing.length ? `not on this key: ${missing.join(", ")}` : "",
          noGenerate.length ? `can't generate text: ${noGenerate.join(", ")}` : "",
        ].filter(Boolean);

        checks.push({
          name: "Gemini models",
          ok: usable.length > 0,
          detail: problems.length
            ? `Configured: ${GEMINI_MODELS.join(", ")} — ${problems.join("; ")}.` +
              (usable.length ? ` Still usable: ${usable.join(", ")}.` : "")
            : `All ${GEMINI_MODELS.length} configured model(s) exist and can generate: ${GEMINI_MODELS.join(", ")}.`,
          fix:
            usable.length === 0
              ? "Every model name this app calls was rejected by your key. Set GEMINI_MODEL in Vercel to one Google lists for you, then REDEPLOY."
              : undefined,
        });
      }
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
