import { supabaseAdmin } from "@/lib/supabase/server";
import { replyUsage } from "@/lib/billing/quota";

/**
 * Can this shop legally and practically send a broadcast right now?
 *
 * The gate used to read rows from a table someone had to write by hand: no
 * rows meant blocked forever, and a row saying passed=true meant nothing,
 * because nothing had checked anything. A gate that cannot fail for a real
 * reason cannot pass for one either.
 *
 * Each check below is computed from the state it describes, and each says what
 * to do about it — the same rule the setup diagnostics follow, for the same
 * reason: a blocked screen that names no action is a dead end.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** A warning informs; only a blocking failure stops the send. */
  blocking: boolean;
}

export interface Readiness {
  canSend: boolean;
  checks: Check[];
}

export async function campaignReadiness(businessId: string): Promise<Readiness> {
  const [channel, templates, optIns, usage, stored] = await Promise.all([
    supabaseAdmin
      .from("channels")
      .select("access_token, phone_number_id")
      .eq("business_id", businessId)
      .eq("channel_type", "whatsapp")
      .maybeSingle(),
    supabaseAdmin
      .from("message_templates")
      .select("name")
      .eq("business_id", businessId)
      .eq("channel_type", "whatsapp")
      .eq("is_active", true),
    supabaseAdmin
      .from("opt_ins")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("consent_status", "opted_in"),
    replyUsage(businessId),
    supabaseAdmin
      .from("compliance_checks")
      .select("label, description, passed")
      .eq("business_id", businessId),
  ]);

  const credentials = channel.data as { access_token?: string; phone_number_id?: string } | null;
  const templateNames = ((templates.data ?? []) as Array<{ name: string }>).map((t) => t.name);
  const contacts = optIns.count ?? 0;

  const checks: Check[] = [
    {
      name: "WhatsApp connected",
      ok: Boolean(credentials?.access_token && credentials?.phone_number_id),
      detail: credentials?.access_token
        ? "Connected and ready to send."
        : "No WhatsApp channel is connected, so there is nothing to broadcast on.",
      fix: credentials?.access_token ? undefined : "Add your WhatsApp credentials under Channels.",
      blocking: true,
    },
    {
      name: "Approved template",
      ok: templateNames.length > 0,
      // Meta's rule, not ours: outside 24 hours of a customer's own last
      // message only a pre-approved template may be sent, and a broadcast is
      // outside that window by definition.
      detail: templateNames.length
        ? `${templateNames.length} approved template(s): ${templateNames.slice(0, 3).join(", ")}.`
        : "A broadcast reaches people who haven't messaged you in the last 24 hours, and Meta only allows a pre-approved template to do that.",
      fix: templateNames.length
        ? undefined
        : "Get a template approved in WhatsApp Manager, then add it under Campaigns.",
      blocking: true,
    },
    {
      name: "People who agreed to hear from you",
      ok: contacts > 0,
      detail:
        contacts > 0
          ? `${contacts} contact(s) have opted in.`
          : "Nobody has opted in, so a broadcast would have no legitimate recipients.",
      fix: contacts > 0 ? undefined : "Opt-ins are recorded when a customer agrees in chat.",
      blocking: true,
    },
    {
      name: "Monthly allowance",
      ok: !usage.exceeded,
      detail: `${usage.used} of ${usage.limit} messages used this month.`,
      fix: usage.exceeded ? "The allowance resets on the 1st, or move to a larger plan." : undefined,
      blocking: true,
    },
  ];

  // Anything recorded by hand still counts — it is someone's deliberate note
  // that this shop is not clear to send, and computing four checks is no
  // reason to overrule it.
  for (const row of (stored.data ?? []) as Array<{
    label: string;
    description: string | null;
    passed: boolean;
  }>) {
    checks.push({
      name: row.label,
      ok: row.passed,
      detail: row.description ?? (row.passed ? "Passed." : "Recorded as not passing."),
      blocking: true,
    });
  }

  return {
    canSend: checks.every((check) => check.ok || !check.blocking),
    checks,
  };
}
