import { supabaseAdmin, serviceRoleKeyProblem } from "@/lib/supabase/server";
import { generateCustomerReply } from "@/lib/ai/gemini";
import { replyUsage, QUOTA_MESSAGE } from "@/lib/billing/quota";

/**
 * The web chat widget: the shop's own site as a channel.
 *
 * Every other channel arrives through a webhook Meta has already authenticated,
 * and answers asynchronously. This one is the opposite — an anonymous browser
 * on someone else's website, waiting for the reply in the response body. So the
 * guards live here rather than at the edge: nothing upstream has vouched for
 * the caller, and the business id is printed in the embed snippet on a public
 * page, which makes it an address, never a secret.
 */

const HISTORY_LIMIT = 10;

/** Long enough for a real question, short enough not to be a payload. */
const MAX_MESSAGE_LENGTH = 1000;

/** One visitor should not be able to hold the whole shop's allowance. */
const MAX_PER_SESSION_PER_MINUTE = 6;

/**
 * Gemini's free tier is roughly 20 requests a minute for the entire key, and
 * the widget is the only channel a stranger can reach unprompted. Keeping it
 * under that ceiling means an abusive visitor degrades the widget rather than
 * silencing WhatsApp for real customers.
 */
const MAX_PER_BUSINESS_PER_MINUTE = 15;

const RATE_WINDOW_MS = 60_000;

export interface WidgetMessage {
  businessId: string;
  sessionId: string;
  text: string;
  customerName?: string;
  origin?: string | null;
}

export type WidgetOutcome =
  | { ok: true; reply: string; conversationId: string }
  | { ok: false; status: number; error: string };

/** Session ids come from a stranger's browser; keep them boring. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Does `origin` satisfy one of the shop's allowed origins?
 *
 * An empty allowlist means the shop hasn't restricted embedding, which is the
 * honest default for a widget whose whole job is to be embedded — the rate
 * limits, not the allowlist, are what stop abuse.
 */
export function originAllowed(origin: string | null | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!origin) return false;

  return allowed.some((entry) => {
    const pattern = entry.trim().replace(/\/+$/, "");
    if (!pattern) return false;
    if (pattern === "*") return true;

    // "*.shop.com" should match https://www.shop.com but not https://shop.com.evil.net
    if (pattern.includes("*")) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*");
      return new RegExp(`^${escaped}$`, "i").test(origin.replace(/\/+$/, ""));
    }
    return pattern.toLowerCase() === origin.replace(/\/+$/, "").toLowerCase();
  });
}

/** How many customer messages arrived in the last minute, and where from. */
async function recentCustomerMessages(
  businessId: string,
  conversationId: string | null
): Promise<{ session: number; business: number }> {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();

  const businessQuery = supabaseAdmin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("sender_type", "customer")
    .gte("created_at", since);

  const sessionQuery = conversationId
    ? supabaseAdmin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("sender_type", "customer")
        .gte("created_at", since)
    : null;

  const [business, session] = await Promise.all([businessQuery, sessionQuery]);

  // A broken counting query must not take the widget down with it. The session
  // limit is the one that stops a single abuser, and it is the simpler query.
  if (business.error) console.error("widget: business rate check failed:", business.error);
  if (session?.error) console.error("widget: session rate check failed:", session.error);

  return { session: session?.count ?? 0, business: business.count ?? 0 };
}

/**
 * Answer one message from the embedded widget.
 *
 * Returns the reply rather than sending it: the visitor's browser is holding
 * the request open. Everything is still written to the same conversations and
 * messages tables the other channels use, so a web chat appears in the Inbox
 * alongside WhatsApp and can be taken over by a human in the same way.
 */
export async function handleWidgetMessage(input: WidgetMessage): Promise<WidgetOutcome> {
  const keyProblem = serviceRoleKeyProblem();
  if (keyProblem) return { ok: false, status: 503, error: "The shop's chat is misconfigured." };

  const businessId = (input.businessId ?? "").trim();
  const sessionId = (input.sessionId ?? "").trim();
  const text = (input.text ?? "").trim();

  if (!businessId) return { ok: false, status: 400, error: "No shop was named in the request." };
  if (!SAFE_SESSION_ID.test(sessionId)) {
    return { ok: false, status: 400, error: "That chat session id isn't valid." };
  }
  if (!text) return { ok: false, status: 400, error: "Type a message first." };
  if (text.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      status: 413,
      error: `Please keep it under ${MAX_MESSAGE_LENGTH} characters.`,
    };
  }

  // ---- Is the widget switched on for this shop, and allowed on this site? ----
  const { data: connection } = await supabaseAdmin
    .from("channel_connections")
    .select("status, config")
    .eq("business_id", businessId)
    .eq("channel_type", "web")
    .maybeSingle();

  if (!connection || connection.status === "not_connected") {
    // Deliberately the same answer as an unknown business id: a public endpoint
    // should not confirm which shop ids exist.
    return { ok: false, status: 403, error: "This shop's web chat isn't switched on." };
  }

  const config = (connection.config ?? {}) as { allowed_origins?: unknown };
  const allowed = Array.isArray(config.allowed_origins)
    ? config.allowed_origins.filter((o): o is string => typeof o === "string")
    : [];

  if (!originAllowed(input.origin, allowed)) {
    return { ok: false, status: 403, error: "This chat isn't enabled for this website." };
  }

  // ---- Conversation ----
  const { data: existing } = await supabaseAdmin
    .from("conversations")
    .select("id, status")
    .eq("business_id", businessId)
    .eq("channel_type", "web")
    .eq("customer_identifier", sessionId)
    .maybeSingle();

  // The monthly ceiling, checked before the per-minute one: a shop that has
  // spent its allowance should be told so, not asked to wait a minute and try
  // the same thing again.
  const usage = await replyUsage(businessId);

  const rate = await recentCustomerMessages(businessId, existing?.id ?? null);
  if (rate.session >= MAX_PER_SESSION_PER_MINUTE) {
    return { ok: false, status: 429, error: "You're sending messages very quickly — one moment." };
  }
  if (rate.business >= MAX_PER_BUSINESS_PER_MINUTE) {
    return { ok: false, status: 429, error: "The shop's assistant is busy right now. Try again shortly." };
  }

  const customerName = (input.customerName ?? "").trim().slice(0, 80) || "Website visitor";
  const now = new Date().toISOString();
  let conversationId: string;
  let status: string;

  if (existing) {
    conversationId = existing.id;
    status = existing.status;
    await supabaseAdmin
      .from("conversations")
      .update({
        last_message_preview: text.slice(0, 200),
        last_message_at: now,
        updated_at: now,
      })
      .eq("id", conversationId);
  } else {
    const { data: created, error } = await supabaseAdmin
      .from("conversations")
      .insert({
        business_id: businessId,
        customer_name: customerName,
        customer_identifier: sessionId,
        channel_type: "web",
        status: "bot_active",
        last_message_preview: text.slice(0, 200),
        last_message_at: now,
      })
      .select("id, status")
      .single();

    if (error || !created) {
      console.error("widget: could not create conversation:", error);
      return { ok: false, status: 500, error: "Couldn't start that chat. Please try again." };
    }
    conversationId = created.id;
    status = created.status;
  }

  await supabaseAdmin.from("messages").insert({
    business_id: businessId,
    conversation_id: conversationId,
    sender_type: "customer",
    direction: "incoming",
    body: text,
    created_at: now,
  });

  // Out of allowance: keep the customer's message — it is a real enquiry the
  // shop will want — but answer honestly instead of spending a reply the shop
  // has not paid for.
  if (usage.exceeded) {
    await supabaseAdmin.from("messages").insert({
      business_id: businessId,
      conversation_id: conversationId,
      sender_type: "system",
      direction: "outgoing",
      body: `Monthly reply limit reached (${usage.used}/${usage.limit}).`,
    });
    return { ok: true, conversationId, reply: QUOTA_MESSAGE };
  }

  // A human has taken this conversation over. Keep the visitor's message, but
  // don't have the bot talk across the person now handling it.
  if (status === "handed_off") {
    return {
      ok: true,
      conversationId,
      reply: "Thanks — someone from the team is looking at this and will reply here shortly.",
    };
  }

  const { data: history } = await supabaseAdmin
    .from("messages")
    .select("sender_type, body")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(HISTORY_LIMIT);

  const formatted = (history ?? [])
    .slice(0, -1) // drop the message just stored
    .map((h: { sender_type: string; body: string }) => ({
      sender: h.sender_type === "customer" ? ("customer" as const) : ("bot" as const),
      text: h.body,
    }));

  const reply = await generateCustomerReply(businessId, text, formatted, {
    channelType: "web",
    conversationId,
    customerName,
  });

  await supabaseAdmin.from("messages").insert({
    business_id: businessId,
    conversation_id: conversationId,
    sender_type: "bot",
    direction: "outgoing",
    body: reply.text,
  });

  await supabaseAdmin
    .from("conversations")
    .update({
      last_message_preview: reply.text.slice(0, 200),
      last_message_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  // reply.reason is deliberately not returned: it is operator diagnostics and
  // names internal configuration. The shop sees it in the playground.
  return { ok: true, reply: reply.text, conversationId };
}
