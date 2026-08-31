import Stripe from "stripe";

export type ChannelType = "whatsapp" | "instagram" | "messenger" | "web";

export const CHANNEL_TYPES: ChannelType[] = ["whatsapp", "instagram", "messenger", "web"];

export interface CreateOrderInput {
  businessId: string;
  customerName: string;
  channelType: ChannelType;
  items: Array<{ product_id: string; quantity: number }>;
  conversationId?: string | null;
  createPaymentLink?: boolean;
  appUrl?: string;
}

export interface CreatedOrder {
  id: string;
  display_id: string;
  total_cents: number;
  currency: string;
  payment_link: string | null;
  items: Array<{ name: string; quantity: number; price_cents: number }>;
}

export type CreateOrderResult =
  | { ok: true; order: CreatedOrder; warning?: string }
  | { ok: false; code: string; error: string };

/**
 * Create an order from a list of product ids and quantities.
 *
 * Shared by POST /api/orders/create and the AI's create_order tool so both
 * price the same way. Prices ALWAYS come from the database — a caller (or a
 * language model) never gets to name an amount.
 *
 * `client` is a Supabase client: the HTTP route passes the caller-scoped one
 * so RLS applies, the webhook path passes the service-role one because there
 * is no signed-in user on an inbound message.
 */
export async function createOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  input: CreateOrderInput
): Promise<CreateOrderResult> {
  const { businessId, customerName, channelType, items } = input;

  if (!businessId) {
    return { ok: false, code: "no_business", error: "Missing business." };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, code: "no_items", error: "An order needs at least one item." };
  }

  const productIds = items.map((i) => i.product_id).filter(Boolean);
  if (productIds.length === 0) {
    return { ok: false, code: "no_items", error: "No product ids were given." };
  }

  const { data: productData, error: prodError } = await client
    .from("products")
    .select("id, name, price_cents, currency, is_active")
    .eq("business_id", businessId)
    .in("id", productIds);

  if (prodError) {
    console.error("createOrder product lookup failed:", prodError);
    return { ok: false, code: "lookup_failed", error: "Couldn't load those products." };
  }

  const products = (productData ?? []).filter((p: { is_active: boolean }) => p.is_active);
  if (products.length === 0) {
    return {
      ok: false,
      code: "no_products",
      error: "None of those products are in the catalog (or they're inactive).",
    };
  }

  // One order, one currency — Stripe cannot mix them in a single checkout.
  const currencies = new Set(
    products.map((p: { currency: string | null }) => (p.currency || "USD").toUpperCase())
  );
  if (currencies.size > 1) {
    return {
      ok: false,
      code: "mixed_currency",
      error: `This order mixes currencies (${[...currencies].join(", ")}). Use one order per currency.`,
    };
  }
  const currency = ([...currencies][0] as string) || "USD";

  let totalCents = 0;
  const orderItems: Array<{
    product_id: string;
    name: string;
    quantity: number;
    price_cents: number;
  }> = [];

  for (const item of items) {
    const product = products.find((p: { id: string }) => p.id === item.product_id);
    if (!product) continue;

    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    totalCents += product.price_cents * quantity;
    orderItems.push({
      product_id: product.id,
      name: product.name,
      quantity,
      price_cents: product.price_cents,
    });
  }

  if (orderItems.length === 0) {
    return { ok: false, code: "no_items", error: "No orderable items were found." };
  }

  const displayId = `ORD-${Date.now().toString(36).toUpperCase()}`;

  const { data: order, error: orderError } = await client
    .from("orders")
    .insert({
      business_id: businessId,
      conversation_id: input.conversationId || null,
      display_id: displayId,
      customer_name: customerName || "Guest",
      channel_type: channelType,
      total_cents: totalCents,
      currency,
      status: "draft",
    })
    .select()
    .single();

  if (orderError || !order) {
    console.error("createOrder insert failed:", orderError);
    return { ok: false, code: "insert_failed", error: "Couldn't create the order." };
  }

  const { error: itemsError } = await client
    .from("order_items")
    .insert(orderItems.map((item) => ({ ...item, order_id: order.id })));

  if (itemsError) {
    console.error("createOrder order_items insert failed:", itemsError);
  }

  const result: CreatedOrder = {
    id: order.id,
    display_id: displayId,
    total_cents: totalCents,
    currency,
    payment_link: null,
    items: orderItems.map(({ name, quantity, price_cents }) => ({ name, quantity, price_cents })),
  };

  // ---- Optional Stripe Checkout link ----
  if (!input.createPaymentLink || totalCents <= 0) {
    return { ok: true, order: result };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return {
      ok: true,
      order: result,
      warning: "Order created without a payment link: STRIPE_SECRET_KEY isn't configured.",
    };
  }

  try {
    const stripe = new Stripe(secretKey);
    const appUrl = input.appUrl || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: orderItems.map((item) => ({
        price_data: {
          currency: currency.toLowerCase(),
          product_data: { name: item.name },
          unit_amount: item.price_cents,
        },
        quantity: item.quantity,
      })),
      success_url: `${appUrl}/orders/${order.id}?success=true`,
      cancel_url: `${appUrl}/orders/${order.id}?canceled=true`,
      metadata: { order_id: order.id, business_id: businessId },
    });

    result.payment_link = session.url;

    await client
      .from("orders")
      .update({
        payment_link: session.url,
        stripe_payment_intent_id:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
        status: "pending_payment",
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("business_id", businessId);

    return { ok: true, order: result };
  } catch (stripeError) {
    console.error("createOrder Stripe session failed:", stripeError);
    return {
      ok: true,
      order: result,
      warning: "Order created, but the payment link couldn't be generated.",
    };
  }
}
