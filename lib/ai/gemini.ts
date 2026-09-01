import { supabaseAdmin, serviceRoleKeyProblem } from "@/lib/supabase/server";
import { createOrder, type ChannelType } from "@/lib/orders/create";

// ============================================================================
// One AI brain for every channel.
//
// There used to be two: getAIReply() declared tools but threw when the API key
// was missing (500ing the webhook and triggering Meta retries), and
// generateCustomerReply() had model fallback but no tools. Which one answered
// a WhatsApp customer depended on which of two near-identical routes Meta was
// pointed at. This is the merge: tools AND fallback AND never throwing.
// ============================================================================

const MAX_TOOL_ROUNDS = 3;
const CATALOG_CONTEXT_LIMIT = 20;

/**
 * Room for a reply. Generous on purpose: this budget also covers any thinking
 * the model does, and a customer answer cut off mid-sentence is worse than a
 * slightly slower one.
 */
const MAX_OUTPUT_TOKENS = 2048;

/**
 * Whether a model accepts `thinkingConfig`. Sending it to one that doesn't —
 * 2.0 and 1.5 — is a 400 on every request, so this must stay a whitelist.
 */
function supportsThinking(model: string): boolean {
  return /^gemini-(2\.5|3)/.test(model);
}

/**
 * Models tried in order; the next one is used when a model is busy or down.
 * Exported so /api/diagnostics can check these exact names against the key —
 * a retired model name fails every single request while the key itself tests
 * perfectly, and nothing else in the app would ever reveal that.
 */
export const GEMINI_MODELS = Array.from(
  new Set(
    [
      process.env.GEMINI_MODEL || process.env.NEXT_PUBLIC_GEMINI_MODEL,
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
    ].filter(Boolean) as string[]
  )
);

export interface MessageHistory {
  sender: "customer" | "bot" | "agent";
  text: string;
  timestamp?: string;
}

export interface ToolCall {
  name: string;
  params: Record<string, unknown>;
  result?: unknown;
  ok?: boolean;
}

export interface CatalogMatch {
  id: string;
  name: string;
  sku: string;
  price_cents: number;
  currency: string;
  description?: string | null;
}

export interface CustomerReply {
  text: string;
  source: "gemini" | "catalog" | "error";
  model?: string;
  toolsUsed: ToolCall[];
  matchedProducts: CatalogMatch[];
  /**
   * Why the answer came from where it did — for operators, never shown to a
   * customer. Set whenever Gemini was skipped or the catalog was unreachable,
   * so "the bot isn't answering" resolves to one concrete missing setting
   * instead of a screenshot-reading session.
   */
  reason?: string;
}

export interface ReplyOptions {
  channelType?: ChannelType;
  conversationId?: string | null;
  customerName?: string;
  /** Set false to answer without offering to place orders. */
  allowTools?: boolean;
  /**
   * Refuse any tool that writes. The tools are still declared, so the request
   * sent to Gemini is byte-for-byte the production one — which is the point:
   * a malformed tool declaration 400s every real reply, and a check that
   * quietly dropped the tools would report that setup as healthy.
   */
  readOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Gemini wire types
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------

const TOOL_DECLARATIONS = [
  {
    functionDeclarations: [
      {
        name: "search_products",
        description:
          "Search the catalog by name, SKU or description. Use this before answering any question about what is available, what something costs, or whether an item is in stock.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "What the customer is looking for" },
          },
          required: ["query"],
        },
      },
      {
        name: "create_order",
        description:
          "Place an order once the customer has clearly confirmed exactly what they want. Never call this speculatively — only after an explicit yes. Returns an order number and, when payments are configured, a checkout link to give the customer.",
        parameters: {
          type: "OBJECT",
          properties: {
            customer_name: { type: "STRING", description: "The customer's name" },
            items: {
              type: "ARRAY",
              description: "The products to order",
              items: {
                type: "OBJECT",
                properties: {
                  product_id: {
                    type: "STRING",
                    description: "The product's id, exactly as returned by search_products",
                  },
                  quantity: { type: "INTEGER", description: "How many" },
                },
                required: ["product_id", "quantity"],
              },
            },
          },
          required: ["customer_name", "items"],
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

/** Strip PostgREST filter metacharacters so a query can't inject clauses. */
function sanitizeFilter(term: string): string {
  return term.replace(/[(),*"\\]/g, " ").trim();
}

/**
 * Words that carry no product meaning. A customer asks in sentences — "do you
 * have an espresso cup set?" — and every one of these appears in that sentence
 * without narrowing the catalog at all.
 */
const STOPWORDS = new Set([
  "a", "about", "am", "an", "and", "any", "anything", "are", "at", "available",
  "be", "buy", "by", "can", "cost", "costs", "could", "descuento", "do", "does",
  "doing", "for", "from", "get", "give", "got", "hai", "has", "have", "hello",
  "help", "hey", "hi", "how", "i", "if", "in", "is", "it", "its", "just", "kya",
  "like", "looking", "many", "me", "much", "my", "need", "of", "on", "one",
  "or", "order", "please", "price", "prices", "product", "products", "sell",
  "send", "show", "some", "sth", "stock", "tell", "thanks", "that", "the",
  "their", "them", "there", "these", "they", "this", "to", "us", "want",
  "was", "we", "what", "whats", "when", "where", "which", "will", "with",
  "would", "you", "your", "yours",
]);

/** How many words we are willing to turn into ILIKE patterns. */
const MAX_SEARCH_KEYWORDS = 5;

/**
 * Pull the words worth searching for out of a customer's sentence.
 *
 * Longest first, because the specific word ("espresso") is almost always
 * longer than the generic one ("set"), and we only get five.
 */
export function searchKeywords(query: string): string[] {
  const words = (query || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));

  const seen = new Set<string>();
  const unique = words.filter((w) => (seen.has(w) ? false : (seen.add(w), true)));

  // Nothing but stopwords ("do you have any?") — fall back to the whole
  // phrase rather than searching for nothing at all.
  if (unique.length === 0) {
    const whole = (query || "").trim().toLowerCase();
    return whole ? [whole] : [];
  }

  return [...unique]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_SEARCH_KEYWORDS);
}

/**
 * Look up products, reporting *why* nothing came back.
 *
 * "No such product" and "the database rejected our key" produce the same empty
 * array, and telling a customer we can't find their mug when the real problem is
 * a missing environment variable sends everyone hunting in the wrong place.
 *
 * Matching is per keyword, not per sentence. Sending "do you have an espresso
 * cup set" to the database as one ILIKE pattern looks for a product literally
 * named that, finds nothing, and reports an empty catalog — while the single
 * word "cup" finds the same product immediately.
 */
async function searchCatalog(
  businessId: string,
  query: string,
  limit = 5
): Promise<{ matches: CatalogMatch[]; error: string | null }> {
  const keyProblem = serviceRoleKeyProblem();
  if (keyProblem) return { matches: [], error: keyProblem };

  if (!businessId) return { matches: [], error: "No business id was supplied with the message." };

  const keywords = searchKeywords(query)
    .map((word) => sanitizeFilter(word))
    .filter(Boolean);
  if (keywords.length === 0) return { matches: [], error: null };

  const filters = keywords.flatMap((word) => [
    `name.ilike.%${word}%`,
    `sku.ilike.%${word}%`,
    `description.ilike.%${word}%`,
  ]);

  // Over-fetch: the database returns matches in no useful order, so ranking
  // has to happen here, and ranking the first `limit` rows ranks nothing.
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, name, sku, price_cents, currency, description")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .or(filters.join(","))
    .limit(Math.max(limit * 6, 30));

  if (error) {
    console.error("searchCatalog failed:", error);
    return { matches: [], error: `Catalog lookup failed: ${error.message}` };
  }

  const ranked = rankMatches((data ?? []) as CatalogMatch[], keywords).slice(0, limit);
  return { matches: ranked, error: null };
}

/**
 * Order products by how well they match, best first.
 *
 * A keyword in the name (or SKU) is the customer naming the product; the same
 * word buried in a description is a passing mention. Weighted 3 to 1 so a
 * "Espresso Cup Set" outranks a teapot whose description says "pairs with our
 * espresso cups".
 */
function rankMatches(products: CatalogMatch[], keywords: string[]): CatalogMatch[] {
  const score = (p: CatalogMatch): number => {
    const name = `${p.name ?? ""} ${p.sku ?? ""}`.toLowerCase();
    const description = (p.description ?? "").toLowerCase();
    return keywords.reduce((total, word) => {
      if (name.includes(word)) return total + 3;
      if (description.includes(word)) return total + 1;
      return total;
    }, 0);
  };

  return products
    .map((p, index) => ({ p, index, score: score(p) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.p);
}

function formatPrice(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency || "USD"}`;
}

function formatCatalogAnswer(matches: CatalogMatch[]): string {
  if (matches.length === 0) {
    return "I couldn't find that in our catalog. Could you describe it a different way, or tell me roughly what you're after?";
  }
  const lines = matches.map(
    (p) =>
      `• ${p.name} — ${formatPrice(p.price_cents, p.currency)}${p.description ? ` (${p.description})` : ""}`
  );
  return `Here's what I found:\n\n${lines.join("\n")}\n\nWould you like me to put an order together?`;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export async function processToolCall(
  businessId: string,
  toolName: string,
  params: Record<string, unknown>,
  options: ReplyOptions = {}
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    if (toolName === "search_products" || toolName === "get_product_price") {
      const query = String(params.query ?? params.product_query ?? "");
      const { matches, error: catalogError } = await searchCatalog(businessId, query);

      if (catalogError) {
        return { success: false, error: catalogError };
      }

      if (matches.length === 0) {
        return { success: true, result: { found: 0, products: [], note: "No match in the catalog." } };
      }

      return {
        success: true,
        result: {
          found: matches.length,
          products: matches.map((p) => ({
            product_id: p.id,
            name: p.name,
            sku: p.sku,
            price: formatPrice(p.price_cents, p.currency),
            price_cents: p.price_cents,
            currency: p.currency,
            description: p.description ?? undefined,
          })),
        },
      };
    }

    if (toolName === "create_order") {
      if (options.readOnly) {
        return {
          success: false,
          error: "This is a configuration test, so no order was placed. Tell the customer what you would have ordered instead.",
        };
      }

      const items = Array.isArray(params.items)
        ? (params.items as Array<{ product_id: string; quantity: number }>)
        : [];

      const created = await createOrder(supabaseAdmin, {
        businessId,
        customerName: String(params.customer_name || options.customerName || "Guest"),
        channelType: options.channelType ?? "web",
        conversationId: options.conversationId ?? null,
        items,
        createPaymentLink: true,
      });

      if (!created.ok) {
        return { success: false, error: created.error };
      }

      return {
        success: true,
        result: {
          order_number: created.order.display_id,
          total: formatPrice(created.order.total_cents, created.order.currency),
          payment_link: created.order.payment_link,
          items: created.order.items.map((i) => `${i.quantity}x ${i.name}`),
          note: created.order.payment_link
            ? "Give the customer the payment link so they can complete checkout."
            : "No payment link is available; tell the customer someone will follow up to arrange payment.",
        },
      };
    }

    return { success: false, error: `Unknown tool: ${toolName}` };
  } catch (error) {
    console.error(`Tool ${toolName} threw:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "The tool failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

async function buildSystemPrompt(businessId: string): Promise<string> {
  const [{ data: settings }, { data: products }] = await Promise.all([
    supabaseAdmin.from("agent_settings").select("*").eq("business_id", businessId).maybeSingle(),
    supabaseAdmin
      .from("products")
      .select("name, price_cents, currency, description")
      .eq("business_id", businessId)
      .eq("is_active", true)
      .limit(CATALOG_CONTEXT_LIMIT),
  ]);

  const catalog =
    products && products.length > 0
      ? products
          .map(
            (p: { name: string; price_cents: number; currency: string; description?: string | null }) =>
              `${p.name}: ${formatPrice(p.price_cents, p.currency)}${p.description ? ` - ${p.description}` : ""}`
          )
          .join("\n")
      : "(catalog is empty)";

  const greeting = settings?.greeting_message || "Hi! How can I help you today?";
  const tone = settings?.formality || "Neutral";
  const emoji = settings?.emoji_enabled
    ? "You may use the occasional emoji."
    : "Do not use emojis.";

  return `You are a customer service assistant for an online shop, talking to a customer in a chat window.

Your opening line, if you need one: "${greeting}"
Tone: ${tone}. ${emoji}

A sample of the catalog (not the whole thing):
${catalog}

How to work:
- Use search_products whenever the customer asks about an item, a price, or availability. The sample above may be incomplete or stale — the tool is the source of truth.
- Quote only prices the tool returned. Never invent or estimate a price.
- Before ordering, confirm the exact item and quantity in your own words and wait for a clear yes.
- Only then call create_order, using the product_id values search_products gave you.
- After an order is placed, tell the customer the order number and give them the payment link verbatim if there is one.
- If a tool reports an error, say plainly what went wrong and offer to pass them to a human. Never pretend an order succeeded.
- Keep replies short and natural — this is a chat, not an email.`;
}

// ---------------------------------------------------------------------------
// Gemini call
// ---------------------------------------------------------------------------

async function callGemini(
  model: string,
  apiKey: string,
  systemPrompt: string,
  contents: GeminiContent[],
  useTools: boolean
): Promise<GeminiPart[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Header, not ?key= — query strings end up in proxy and error logs.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        ...(useTools ? { tools: TOOL_DECLARATIONS } : {}),
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // 2.5 models think before answering, and thinking is billed against
          // the same output budget as the reply. Left on, the model can spend
          // the whole budget reasoning and return a 200 with no parts at all —
          // which reads exactly like "the model had nothing to say". A shop
          // assistant quoting its own catalog does not need a scratchpad.
          ...(supportsThinking(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    }
  );

  const data = (await res.json().catch(() => ({}))) as {
    candidates?: Array<{
      content?: { parts?: GeminiPart[] };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
    error?: { message?: string; status?: string };
  };

  // Throw rather than return null. A silent null is indistinguishable from
  // "the model had nothing to say", so every failure used to land the customer
  // on the catalog fallback with no record anywhere of what went wrong. The
  // caller turns this message into the reason line under the reply.
  if (!res.ok) {
    const detail = data.error?.message || res.statusText || "no detail";
    throw new Error(`HTTP ${res.status} — ${detail}`);
  }

  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts;

  if (!parts || parts.length === 0) {
    // A 200 with no parts is how a safety block arrives, and how an output
    // budget spent entirely on reasoning arrives. finishReason names which.
    const why =
      data.promptFeedback?.blockReason ??
      candidate?.finishReason ??
      "returned no content";
    throw new Error(`answered with nothing (${why})`);
  }

  return parts;
}

/**
 * Run one model through the full tool loop: ask, run any tools it calls, hand
 * the results back, and repeat until it produces prose (or we hit the cap).
 * Throws — with a sentence describing what went wrong — so the caller can fall
 * through to the next model while keeping a record of why this one didn't work.
 */
async function runToolLoop(
  model: string,
  apiKey: string,
  systemPrompt: string,
  contents: GeminiContent[],
  businessId: string,
  options: ReplyOptions,
  toolsUsed: ToolCall[]
): Promise<string> {
  const useTools = options.allowTools !== false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // On the last round drop the tools, forcing a prose answer rather than
    // another call we have no budget to run.
    const parts = await callGemini(
      model,
      apiKey,
      systemPrompt,
      contents,
      useTools && round < MAX_TOOL_ROUNDS
    );

    const calls = parts.filter((p) => p.functionCall?.name);
    const text = parts
      .map((p) => p.text || "")
      .filter(Boolean)
      .join("\n")
      .trim();

    if (calls.length === 0) {
      if (!text) throw new Error("replied with an empty message");
      return text;
    }

    // Record the model's turn verbatim, then answer each call.
    contents.push({ role: "model", parts: calls });

    const responseParts: GeminiPart[] = [];
    for (const part of calls) {
      const name = part.functionCall!.name!;
      const args = part.functionCall!.args ?? {};
      const outcome = await processToolCall(businessId, name, args, options);

      toolsUsed.push({
        name,
        params: args,
        ok: outcome.success,
        result: outcome.success ? outcome.result : outcome.error,
      });

      responseParts.push({
        functionResponse: {
          name,
          response: outcome.success
            ? { result: outcome.result }
            : { error: outcome.error ?? "The tool failed." },
        },
      });
    }

    contents.push({ role: "user", parts: responseParts });
  }

  throw new Error(
    `was still calling tools after ${MAX_TOOL_ROUNDS} rounds and never wrote an answer`
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Produce a reply for a customer message. Never throws: a missing API key, a
 * rate-limited model or a failing tool all degrade to something sensible
 * rather than 500ing the webhook and triggering provider retries.
 *
 * Order of attack: each Gemini model in turn (with tools), then a direct
 * catalog lookup, then a plain apology.
 */
export async function generateCustomerReply(
  businessId: string,
  customerMessage: string,
  history: MessageHistory[] = [],
  options: ReplyOptions = {}
): Promise<CustomerReply> {
  const toolsUsed: ToolCall[] = [];
  const apiKey = process.env.GEMINI_API_KEY;
  const reasons: string[] = [];

  if (!apiKey) {
    reasons.push(
      "GEMINI_API_KEY is not set, so no model was contacted. Add it in your hosting environment and redeploy."
    );
  }
  if (!businessId) {
    reasons.push("No business id reached the AI, so it had no catalog to answer from.");
  }

  if (apiKey && businessId) {
    let systemPrompt: string;
    try {
      systemPrompt = await buildSystemPrompt(businessId);
    } catch (error) {
      console.error("Failed to build system prompt:", error);
      systemPrompt = "You are a helpful customer service assistant for an online shop.";
    }

    for (const model of GEMINI_MODELS) {
      // Fresh contents per model: a half-finished tool exchange from a model
      // that died mid-loop would confuse the next one.
      const contents: GeminiContent[] = [
        ...history
          .filter((m) => m.text?.trim())
          .map((m) => ({
            role: m.sender === "customer" ? ("user" as const) : ("model" as const),
            parts: [{ text: m.text }],
          })),
        { role: "user" as const, parts: [{ text: customerMessage }] },
      ];

      try {
        const text = await runToolLoop(
          model,
          apiKey,
          systemPrompt,
          contents,
          businessId,
          options,
          toolsUsed
        );
        return { text, source: "gemini", model, toolsUsed, matchedProducts: [] };
      } catch (error) {
        console.warn(`Gemini ${model} failed, trying the next model:`, error);
        reasons.push(`${model}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
  }

  // Fallback: answer straight from the catalog so a product question still
  // gets a real answer when every model is unavailable.
  const { matches, error: catalogError } = await searchCatalog(businessId, customerMessage, 3);
  if (catalogError) reasons.push(catalogError);

  if (matches.length > 0) {
    return {
      text: formatCatalogAnswer(matches),
      source: "catalog",
      toolsUsed,
      matchedProducts: matches,
      reason: reasons.join(" · ") || undefined,
    };
  }

  // The catalog answered and simply held nothing matching. That is a normal
  // conversation, not a broken deployment, so say so plainly.
  if (!catalogError) {
    return {
      text: formatCatalogAnswer([]),
      source: "catalog",
      toolsUsed,
      matchedProducts: [],
      reason: reasons.join(" · ") || undefined,
    };
  }

  return {
    text: "I'm having trouble reaching our system right now. Please try again in a moment, or ask for a human and someone will pick this up.",
    source: "error",
    toolsUsed,
    matchedProducts: [],
    reason: reasons.join(" · ") || undefined,
  };
}

/** @deprecated Use generateCustomerReply — this exists so older imports keep working. */
export const getAIReply = generateCustomerReply;
