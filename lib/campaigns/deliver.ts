import { supabaseAdmin } from "@/lib/supabase/server";
import { sendWhatsAppTemplate } from "@/lib/channels/whatsapp";

/**
 * Actually send the campaign messages that were only ever queued.
 *
 * The scheduler wrote campaign_recipients rows and stopped, so campaigns sat
 * at 'scheduled' forever — correctly, since reporting a broadcast that never
 * left the building is worse than not sending it. This is the half that sends.
 *
 * Deliberately a separate step from queueing: a broadcast is the one thing in
 * this app that cannot be undone once it leaves, so who is going to receive it
 * is decided and written down before anything is transmitted.
 */

/**
 * How many messages one invocation will send.
 *
 * A serverless function is killed at its timeout with no warning and no
 * record of how far it got, so a large campaign has to be sent across several
 * runs. The cron calls this again while `remaining` is above zero.
 */
const BATCH_SIZE = 50;

export interface DeliveryReport {
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
}

interface RecipientRow {
  id: string;
  business_id: string;
  campaign_id: string;
  customer_identifier: string;
  channel_type: string;
}

/**
 * Send one batch of pending recipients for a campaign.
 *
 * Consent is re-checked at send time rather than trusted from queueing: a
 * customer who opts out between the two must not be messaged, and on a
 * campaign scheduled days ahead that gap is where opt-outs actually happen.
 */
export async function deliverCampaign(campaignId: string): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, failed: 0, skipped: 0, remaining: 0 };

  const { data: campaign } = await supabaseAdmin
    .from("campaigns")
    .select("id, business_id, channel_type, template_name, status")
    .eq("id", campaignId)
    .maybeSingle();

  if (!campaign) return report;

  const { data: pending } = await supabaseAdmin
    .from("campaign_recipients")
    .select("id, business_id, campaign_id, customer_identifier, channel_type")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .limit(BATCH_SIZE);

  const recipients = (pending ?? []) as RecipientRow[];
  if (recipients.length === 0) {
    await finishIfDone(campaignId);
    return report;
  }

  const { data: channel } = await supabaseAdmin
    .from("channels")
    .select("access_token, phone_number_id")
    .eq("business_id", campaign.business_id)
    .eq("channel_type", campaign.channel_type)
    .maybeSingle();

  const now = () => new Date().toISOString();

  const markFailed = async (id: string, reason: string) => {
    console.error(`campaign ${campaignId} recipient ${id}: ${reason}`);
    await supabaseAdmin
      .from("campaign_recipients")
      .update({ status: "failed", updated_at: now() })
      .eq("id", id);
  };

  // A missing channel or template fails every recipient for the same reason,
  // so say it once and fail the batch rather than making one Graph call per
  // customer to be told the same thing each time.
  if (campaign.channel_type !== "whatsapp") {
    for (const r of recipients) {
      await markFailed(r.id, `Broadcasts on ${campaign.channel_type} are not supported yet.`);
      report.failed++;
    }
    await recordCounts(campaignId);
    return report;
  }

  if (!channel?.access_token || !channel?.phone_number_id) {
    for (const r of recipients) {
      await markFailed(r.id, "The WhatsApp channel is not connected.");
      report.failed++;
    }
    await recordCounts(campaignId);
    return report;
  }

  for (const recipient of recipients) {
    // ---- Consent, re-checked now rather than at queue time ----
    const { data: consent } = await supabaseAdmin
      .from("opt_ins")
      .select("consent_status")
      .eq("business_id", recipient.business_id)
      .eq("channel_type", recipient.channel_type)
      .eq("customer_identifier", recipient.customer_identifier)
      .maybeSingle();

    if (consent?.consent_status !== "opted_in") {
      await supabaseAdmin
        .from("campaign_recipients")
        .update({ status: "opted_out", updated_at: now() })
        .eq("id", recipient.id);
      report.skipped++;
      continue;
    }

    const sent = await sendWhatsAppTemplate({
      to: recipient.customer_identifier,
      templateName: campaign.template_name as string,
      phoneNumberId: channel.phone_number_id,
      accessToken: channel.access_token,
    });

    if (!sent.success) {
      await markFailed(recipient.id, sent.error ?? "send failed");
      report.failed++;
      continue;
    }

    await supabaseAdmin
      .from("campaign_recipients")
      .update({ status: "sent", updated_at: now() })
      .eq("id", recipient.id);
    report.sent++;
  }

  const { count } = await supabaseAdmin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "pending");

  report.remaining = count ?? 0;

  await recordCounts(campaignId);
  if (report.remaining === 0) await finishIfDone(campaignId);

  return report;
}

/** Keep the campaign's own totals in step with its recipients. */
async function recordCounts(campaignId: string): Promise<void> {
  const [sent, failed] = await Promise.all([
    supabaseAdmin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "sent"),
    supabaseAdmin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "failed"),
  ]);

  await supabaseAdmin
    .from("campaigns")
    .update({
      sent_count: sent.count ?? 0,
      failed_count: failed.count ?? 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
}

/**
 * Close the campaign once nothing is pending.
 *
 * 'sent' means it went out, so a campaign where every single message failed is
 * marked failed instead — otherwise the dashboard reports a successful
 * broadcast that no customer received.
 */
async function finishIfDone(campaignId: string): Promise<void> {
  const [pending, sent] = await Promise.all([
    supabaseAdmin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "pending"),
    supabaseAdmin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "sent"),
  ]);

  if ((pending.count ?? 0) > 0) return;

  await supabaseAdmin
    .from("campaigns")
    .update({
      status: (sent.count ?? 0) > 0 ? "sent" : "failed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
}
