import type { ChannelType } from "@/lib/orders/create";

/**
 * Which account did Meta deliver this to?
 *
 * A webhook payload names its destination — a phone number id, a page id, an
 * Instagram account id — and that is the only thing in the request that says
 * which shop the message belongs to. Everything else about the delivery is
 * identical for every customer of this app.
 */
export function accountIdFromPayload(channelType: ChannelType, body: unknown): string | null {
  const payload = body as {
    entry?: Array<{
      id?: string;
      changes?: Array<{ value?: { metadata?: { phone_number_id?: string } } }>;
    }>;
  };

  const entry = payload?.entry?.[0];
  if (!entry) return null;

  if (channelType === "whatsapp") {
    // The business's own number, not the customer's: several shops can share
    // one Meta app, and this is what separates them.
    return entry.changes?.[0]?.value?.metadata?.phone_number_id ?? null;
  }

  // Messenger and Instagram both put the receiving account in entry.id.
  return entry.id ?? null;
}

/** The column on `channels` that holds this channel's account id. */
export function accountColumn(channelType: ChannelType): string {
  if (channelType === "whatsapp") return "phone_number_id";
  if (channelType === "instagram") return "instagram_business_account_id";
  return "page_id";
}
