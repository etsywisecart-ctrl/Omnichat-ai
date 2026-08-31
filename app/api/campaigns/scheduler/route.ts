import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

/**
 * POST /api/campaigns/scheduler
 * Process scheduled campaigns and send messages
 *
 * This is typically called by a cron job or background worker.
 * For local development/testing, can be called manually.
 *
 * Rules:
 * - Process campaigns whose scheduled_at has passed
 * - Requires CAMPAIGN_CRON_SECRET as a bearer token; an unset secret refuses
 *   the request rather than running unprotected
 * - Only opted-in contacts become recipients
 *
 * NOTE: this queues recipient rows. Channel delivery is not wired up yet, so
 * campaigns stay 'scheduled' — they are never reported as sent until a real
 * send happens.
 */
export async function POST(request: NextRequest) {
  try {
    // Verify request (should come from authorized cron job)
    const authHeader = request.headers.get("authorization");
    const expectedToken = process.env.CAMPAIGN_CRON_SECRET;

    // No secret configured means we cannot tell a real cron call from anyone
    // on the internet, so refuse rather than run unprotected.
    if (!expectedToken) {
      console.error("CAMPAIGN_CRON_SECRET is not set; refusing to run the scheduler.");
      return NextResponse.json(
        { error: "not_configured", message: "Campaign scheduler is not configured." },
        { status: 503 }
      );
    }

    if (authHeader !== `Bearer ${expectedToken}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const now = new Date();

    // Fetch campaigns ready to send
    const { data: campaigns, error: campaignsError } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("status", "scheduled")
      .lte("scheduled_at", now.toISOString())
      .order("scheduled_at", { ascending: true });

    if (campaignsError) throw campaignsError;

    if (!campaigns || campaigns.length === 0) {
      return NextResponse.json(
        { message: "No campaigns to send", processed: 0 },
        { status: 200 }
      );
    }

    let totalQueued = 0;
    let totalFailed = 0;

    for (const campaign of campaigns) {
      try {
        // A campaign with no approved template can only reach customers who
        // messaged in within the last 24 hours. Without a template we cannot
        // guarantee that for a broadcast, so we refuse the whole campaign.
        if (!campaign.template_name) {
          console.warn(
            `Campaign ${campaign.id} has no approved template, so it cannot be broadcast outside the 24-hour service window.`
          );
          await supabaseAdmin
            .from("campaigns")
            .update({ status: "failed", updated_at: now.toISOString() })
            .eq("id", campaign.id);
          totalFailed++;
          continue;
        }

        // Fetch opted-in recipients for this campaign
        const { data: optIns, error: optInsError } = await supabaseAdmin
          .from("opt_ins")
          .select("customer_identifier")
          .eq("business_id", campaign.business_id)
          .eq("channel_type", campaign.channel_type)
          .eq("consent_status", "opted_in");

        if (optInsError) throw optInsError;

        // Create campaign recipients
        const recipients = (optIns || []).map((oi: any) => ({
          business_id: campaign.business_id,
          campaign_id: campaign.id,
          customer_identifier: oi.customer_identifier,
          channel_type: campaign.channel_type,
          status: "pending" as const,
        }));

        if (recipients.length > 0) {
          const { error: recipientsError } = await supabaseAdmin
            .from("campaign_recipients")
            .insert(recipients);

          if (recipientsError) throw recipientsError;
        }

        // Recipients are queued as 'pending'. Delivery through the channel
        // APIs is not wired up yet, so the campaign stays 'scheduled' rather
        // than reporting a broadcast that never left the building. The status
        // moves to 'sent' only when a delivery worker marks the recipients
        // sent.
        const { error: updateError } = await supabaseAdmin
          .from("campaigns")
          .update({ updated_at: now.toISOString() })
          .eq("id", campaign.id);

        if (updateError) throw updateError;

        totalQueued += recipients.length;

        console.log(
          `Campaign ${campaign.id}: queued ${recipients.length} recipient(s); awaiting a delivery worker.`
        );
      } catch (campaignError) {
        console.error(`Error processing campaign ${campaign.id}:`, campaignError);

        // Mark campaign as failed
        await supabaseAdmin
          .from("campaigns")
          .update({ status: "failed" })
          .eq("id", campaign.id);

        totalFailed++;
      }
    }

    return NextResponse.json(
      {
        message: "Campaigns processed",
        processed: campaigns.length,
        totalQueued,
        totalFailed,
        note: "Recipients are queued as pending. Channel delivery is not implemented yet.",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Campaign scheduler error:", error);
    return new NextResponse(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * GET /api/campaigns/scheduler
 * Health check and status info
 */
export async function GET() {
  const now = new Date();

  // Fetch pending campaigns
  const { data: pendingCampaigns } = await supabaseAdmin
    .from("campaigns")
    .select("id, name, status")
    .eq("status", "scheduled")
    .lte("scheduled_at", now.toISOString());

  return NextResponse.json({
    status: "ok",
    timestamp: now.toISOString(),
    configured: Boolean(process.env.CAMPAIGN_CRON_SECRET),
    pendingCampaigns: pendingCampaigns?.length || 0,
  });
}
