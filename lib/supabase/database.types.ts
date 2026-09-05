// Hand-written to match supabase/schema.sql. Once your Supabase project is
// live you can regenerate this with:
//   npx supabase gen types typescript --project-id YOUR_REF > lib/supabase/database.types.ts

export interface Database {
  public: {
    Tables: {
      businesses: {
        Row: { id: string; name: string; created_at: string };
        Insert: { id?: string; name: string; created_at?: string };
        Update: Partial<Database["public"]["Tables"]["businesses"]["Insert"]>;
      };
      agents: {
        Row: {
          id: string;
          business_id: string;
          user_id: string | null;
          name: string;
          email: string;
          role: "owner" | "agent";
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["agents"]["Row"]> & {
          business_id: string;
          name: string;
          email: string;
        };
        Update: Partial<Database["public"]["Tables"]["agents"]["Row"]>;
      };
      conversations: {
        Row: {
          id: string;
          business_id: string;
          channel_id: string | null;
          customer_name: string;
          customer_identifier: string | null;
          channel_type: "whatsapp" | "instagram" | "messenger" | "web";
          status: "open" | "bot_active" | "handed_off" | "closed";
          marketing_opt_in: boolean;
          assigned_to: string | null;
          last_message_preview: string | null;
          last_message_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["conversations"]["Row"]> & {
          business_id: string;
          customer_name: string;
          channel_type: "whatsapp" | "instagram" | "messenger" | "web";
        };
        Update: Partial<Database["public"]["Tables"]["conversations"]["Row"]>;
      };
      messages: {
        Row: {
          id: string;
          business_id: string;
          conversation_id: string;
          channel_id: string | null;
          sender_type: "customer" | "agent" | "bot" | "system";
          direction: "incoming" | "outgoing";
          body: string;
          provider_message_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["messages"]["Row"]> & {
          business_id: string;
          conversation_id: string;
          sender_type: "customer" | "agent" | "bot" | "system";
          direction: "incoming" | "outgoing";
          body: string;
        };
        Update: Partial<Database["public"]["Tables"]["messages"]["Row"]>;
      };
      products: {
        Row: {
          id: string;
          business_id: string;
          name: string;
          sku: string;
          // The column has always existed and the AI quotes it to customers;
          // it was simply missing from these hand-written types.
          description: string | null;
          price_cents: number;
          currency: string;
          source: "csv" | "manual" | "api";
          tint_color: string | null;
          is_active: boolean;
          updated_at: string;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["products"]["Row"]> & {
          business_id: string;
          name: string;
          sku: string;
          price_cents: number;
        };
        Update: Partial<Database["public"]["Tables"]["products"]["Row"]>;
      };
      orders: {
        Row: {
          id: string;
          business_id: string;
          conversation_id: string | null;
          display_id: string;
          customer_name: string;
          channel_type: "whatsapp" | "instagram" | "messenger" | "web";
          status: "draft" | "pending_payment" | "paid" | "fulfilled" | "cancelled";
          total_cents: number;
          currency: string;
          payment_link: string | null;
          stripe_payment_intent_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["orders"]["Row"]> & {
          business_id: string;
          display_id: string;
          customer_name: string;
          channel_type: "whatsapp" | "instagram" | "messenger" | "web";
        };
        Update: Partial<Database["public"]["Tables"]["orders"]["Row"]>;
      };
      order_items: {
        Row: {
          id: string;
          order_id: string;
          product_id: string | null;
          name: string;
          quantity: number;
          price_cents: number;
        };
        Insert: Partial<Database["public"]["Tables"]["order_items"]["Row"]> & {
          order_id: string;
          name: string;
          price_cents: number;
        };
        Update: Partial<Database["public"]["Tables"]["order_items"]["Row"]>;
      };
      carts: {
        Row: {
          id: string;
          business_id: string;
          conversation_id: string | null;
          customer_name: string;
          channel_type: "whatsapp" | "instagram" | "messenger" | "web";
          items_summary: string | null;
          value_cents: number;
          currency: string;
          status: "active" | "abandoned" | "converted";
          within_session_window: boolean;
          reminder_sent_note: string | null;
          last_activity_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["carts"]["Row"]> & {
          business_id: string;
          customer_name: string;
          channel_type: "whatsapp" | "instagram" | "messenger" | "web";
        };
        Update: Partial<Database["public"]["Tables"]["carts"]["Row"]>;
      };
      campaigns: {
        Row: {
          id: string;
          business_id: string;
          name: string;
          channel_type: "whatsapp" | "instagram" | "messenger" | "web";
          template_name: string | null;
          target_segment: string | null;
          scheduled_at: string | null;
          status: "draft" | "scheduled" | "sent" | "failed";
          sent_count: number | null;
          failed_count: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["campaigns"]["Row"]> & {
          business_id: string;
          name: string;
          channel_type: "whatsapp" | "instagram" | "messenger" | "web";
        };
        Update: Partial<Database["public"]["Tables"]["campaigns"]["Row"]>;
      };
      compliance_checks: {
        Row: {
          id: string;
          business_id: string;
          label: string;
          description: string | null;
          passed: boolean;
          checked_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["compliance_checks"]["Row"]> & {
          business_id: string;
          label: string;
        };
        Update: Partial<Database["public"]["Tables"]["compliance_checks"]["Row"]>;
      };
      agent_settings: {
        Row: {
          business_id: string;
          greeting_message: string;
          formality: "Casual" | "Neutral" | "Formal";
          emoji_enabled: boolean;
          clarification_cap: number;
          history_window: string;
          cart_abandon_threshold: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["agent_settings"]["Row"]> & {
          business_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["agent_settings"]["Row"]>;
      };
      channel_connections: {
        Row: {
          id: string;
          business_id: string;
          channel_type: "whatsapp" | "instagram" | "messenger" | "web";
          status: "connected" | "not_connected" | "live";
          config: Record<string, unknown>;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["channel_connections"]["Row"]> & {
          business_id: string;
          channel_type: "whatsapp" | "instagram" | "messenger" | "web";
        };
        Update: Partial<Database["public"]["Tables"]["channel_connections"]["Row"]>;
      };
      channels: {
        Row: {
          id: string;
          business_id: string;
          channel_type: "whatsapp" | "instagram" | "messenger";
          name: string;
          status: "connected" | "disconnected" | "pending" | "live";
          provider: string;
          access_token: string | null;
          webhook_secret: string | null;
          phone_number_id: string | null;
          page_id: string | null;
          instagram_business_account_id: string | null;
          metadata: Record<string, unknown>;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["channels"]["Row"]> & {
          business_id: string;
          channel_type: "whatsapp" | "instagram" | "messenger";
          name: string;
        };
        Update: Partial<Database["public"]["Tables"]["channels"]["Row"]>;
      };
      opt_ins: {
        Row: {
          id: string;
          business_id: string;
          channel_type: "whatsapp" | "instagram" | "messenger";
          customer_identifier: string;
          consent_status: "opted_in" | "opted_out" | "unknown";
          source: "inbound" | "form" | "campaign" | "manual";
          metadata: Record<string, unknown>;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["opt_ins"]["Row"]> & {
          business_id: string;
          channel_type: "whatsapp" | "instagram" | "messenger";
          customer_identifier: string;
        };
        Update: Partial<Database["public"]["Tables"]["opt_ins"]["Row"]>;
      };
      message_templates: {
        Row: {
          id: string;
          business_id: string;
          channel_type: "whatsapp" | "instagram" | "messenger";
          name: string;
          body: string;
          variables: Array<{ name: string; required: boolean }>;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["message_templates"]["Row"]> & {
          business_id: string;
          channel_type: "whatsapp" | "instagram" | "messenger";
          name: string;
          body: string;
        };
        Update: Partial<Database["public"]["Tables"]["message_templates"]["Row"]>;
      };
      campaign_recipients: {
        Row: {
          id: string;
          business_id: string;
          campaign_id: string;
          conversation_id: string | null;
          customer_identifier: string;
          channel_type: "whatsapp" | "instagram" | "messenger";
          status: "pending" | "sent" | "delivered" | "failed" | "opted_out";
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["campaign_recipients"]["Row"]> & {
          business_id: string;
          campaign_id: string;
          customer_identifier: string;
          channel_type: "whatsapp" | "instagram" | "messenger";
        };
        Update: Partial<Database["public"]["Tables"]["campaign_recipients"]["Row"]>;
      };
    };
  };
}
