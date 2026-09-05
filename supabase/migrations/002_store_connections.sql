-- ============================================================================
-- Store connections: pull the catalog straight from Shopify or WooCommerce.
--
-- Run this once in Supabase → SQL Editor. Safe to run more than once.
-- ============================================================================

create table if not exists store_connections (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  provider        text not null check (provider in ('shopify','woocommerce')),
  -- Shopify: yourshop.myshopify.com. WooCommerce: https://yourshop.com
  store_url       text not null,
  -- Shopify uses a single Admin API token; WooCommerce a key/secret pair.
  access_token    text,
  consumer_key    text,
  consumer_secret text,
  sync_enabled    boolean not null default true,
  last_synced_at  timestamptz,
  last_status     text,
  last_error      text,
  last_imported   integer not null default 0,
  last_deactivated integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One store per business: two catalogs fighting over the same SKUs would
-- deactivate each other's products on every sync.
create unique index if not exists uq_store_connection
  on store_connections(business_id);

alter table store_connections enable row level security;

-- SECURITY: deliberately NO policy.
--
-- Every other tenant table grants "agents of this business may read their own
-- rows", which is right for products and conversations. These rows hold live
-- API credentials for the shop's store, and the dashboard runs on the anon key
-- in the customer's browser — a read policy here would put a Shopify admin
-- token one devtools tab away. With RLS on and no policy, only the
-- service-role key reaches this table, so credentials stay server-side and the
-- browser is served a masked summary instead.
drop policy if exists "tenant access" on store_connections;
