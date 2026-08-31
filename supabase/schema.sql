-- ============================================================================
-- OmniChat AI — complete database schema
-- ----------------------------------------------------------------------------
-- Paste this whole file into the Supabase SQL Editor and press Run.
-- It is idempotent: running it twice is safe and changes nothing the second
-- time, so you can re-run it after any edit.
--
-- This schema is the single source of truth. It matches
-- lib/supabase/database.types.ts exactly — every table the dashboard queries
-- is created here, scoped to a business (tenant) and protected by RLS.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. Tenancy: businesses + agents
-- ----------------------------------------------------------------------------
-- A business is one merchant account. An agent is a person who can sign in
-- and work that account. Every other table hangs off business_id.
-- ============================================================================

create table if not exists businesses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists agents (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  name        text not null,
  email       text not null default '',
  role        text not null default 'agent' check (role in ('owner', 'agent')),
  created_at  timestamptz not null default now()
);

create index if not exists idx_agents_user     on agents(user_id);
create index if not exists idx_agents_business on agents(business_id);

-- ============================================================================
-- 2. Conversations + messages
-- ----------------------------------------------------------------------------
-- One conversation per (business, channel, customer). Messages are the thread.
--   status:      bot_active (AI is handling) | handed_off (needs a human)
--                | open | closed
--   sender_type: who wrote it   |  direction: which way it travelled
-- ============================================================================

create table if not exists conversations (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references businesses(id) on delete cascade,
  channel_id           uuid,
  customer_name        text not null default 'Unknown',
  customer_identifier  text,
  channel_type         text not null default 'whatsapp'
                         check (channel_type in ('whatsapp','instagram','messenger','web')),
  status               text not null default 'bot_active'
                         check (status in ('open','bot_active','handed_off','closed')),
  marketing_opt_in     boolean not null default false,
  assigned_to          uuid references agents(id) on delete set null,
  last_message_preview text,
  last_message_at      timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- One conversation per customer per channel per business.
create unique index if not exists uq_conversations_customer
  on conversations(business_id, channel_type, customer_identifier)
  where customer_identifier is not null;

create index if not exists idx_conversations_business on conversations(business_id);
create index if not exists idx_conversations_status   on conversations(business_id, status);
create index if not exists idx_conversations_recent   on conversations(business_id, last_message_at desc);

create table if not exists messages (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete cascade,
  conversation_id     uuid not null references conversations(id) on delete cascade,
  channel_id          uuid,
  sender_type         text not null check (sender_type in ('customer','agent','bot','system')),
  direction           text not null check (direction in ('incoming','outgoing')),
  body                text not null,
  provider_message_id text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Stops a retried webhook from creating the message (and the AI reply) twice.
create unique index if not exists uq_messages_provider_id
  on messages(business_id, provider_message_id)
  where provider_message_id is not null;

create index if not exists idx_messages_conversation on messages(conversation_id, created_at);
create index if not exists idx_messages_business     on messages(business_id);

-- ============================================================================
-- 3. Catalog
-- ----------------------------------------------------------------------------
-- What the AI can search, quote and sell. Prices are integer cents — never
-- floats, so money never drifts.
-- ============================================================================

create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name        text not null,
  sku         text not null default '',
  description text,
  price_cents integer not null default 0 check (price_cents >= 0),
  currency    text not null default 'USD',
  source      text not null default 'manual' check (source in ('csv','manual','api')),
  tint_color  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Plain, NOT partial. Postgres will not use a partial index for ON CONFLICT
-- unless the statement repeats the index predicate, which PostgREST cannot do
-- — so a partial index here made every CSV upsert fail with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
-- The importer guarantees a non-empty sku, so blanks can't collide.
drop index if exists uq_products_sku;
create unique index if not exists uq_products_sku on products(business_id, sku);
create index if not exists idx_products_active on products(business_id, is_active);

-- Full-text search so catalog lookups happen in Postgres, not in Node.
create index if not exists idx_products_search on products
  using gin (to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,'') || ' ' || coalesce(sku,'')));

-- ============================================================================
-- 4. Orders
-- ============================================================================

create table if not exists orders (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null references businesses(id) on delete cascade,
  conversation_id          uuid references conversations(id) on delete set null,
  display_id               text not null,
  customer_name            text not null default 'Guest',
  channel_type             text not null default 'web'
                             check (channel_type in ('whatsapp','instagram','messenger','web')),
  status                   text not null default 'draft'
                             check (status in ('draft','pending_payment','paid','fulfilled','cancelled')),
  total_cents              integer not null default 0 check (total_cents >= 0),
  currency                 text not null default 'USD',
  payment_link             text,
  stripe_payment_intent_id text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create unique index if not exists uq_orders_display on orders(business_id, display_id);
create index if not exists idx_orders_status on orders(business_id, status);
create index if not exists idx_orders_recent on orders(business_id, updated_at desc);

create table if not exists order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  product_id  uuid references products(id) on delete set null,
  name        text not null,
  quantity    integer not null default 1 check (quantity > 0),
  price_cents integer not null default 0 check (price_cents >= 0)
);

create index if not exists idx_order_items_order on order_items(order_id);

-- ============================================================================
-- 5. Carts & recovery
-- ============================================================================

create table if not exists carts (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references businesses(id) on delete cascade,
  conversation_id       uuid references conversations(id) on delete set null,
  customer_name         text not null default 'Guest',
  channel_type          text not null default 'web'
                          check (channel_type in ('whatsapp','instagram','messenger','web')),
  items_summary         text,
  value_cents           integer not null default 0 check (value_cents >= 0),
  currency              text not null default 'USD',
  status                text not null default 'active'
                          check (status in ('active','abandoned','converted')),
  within_session_window boolean not null default true,
  reminder_sent_note    text,
  last_activity_at      timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_carts_status on carts(business_id, status);
create index if not exists idx_carts_recent on carts(business_id, last_activity_at desc);

-- ============================================================================
-- 6. Channels & connections
-- ----------------------------------------------------------------------------
-- SECURITY: access_token and webhook_secret are provider credentials. RLS
-- below scopes them to the owning business, but they should ultimately be
-- written and read only by the server, never by the browser.
-- ============================================================================

create table if not exists channels (
  id                            uuid primary key default gen_random_uuid(),
  business_id                   uuid not null references businesses(id) on delete cascade,
  channel_type                  text not null check (channel_type in ('whatsapp','instagram','messenger')),
  name                          text not null,
  status                        text not null default 'pending'
                                  check (status in ('connected','disconnected','pending','live')),
  provider                      text not null default 'meta',
  access_token                  text,
  webhook_secret                text,
  phone_number_id               text,
  page_id                       text,
  instagram_business_account_id text,
  metadata                      jsonb not null default '{}'::jsonb,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

create unique index if not exists uq_channels_type on channels(business_id, channel_type);

create table if not exists channel_connections (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  channel_type text not null check (channel_type in ('whatsapp','instagram','messenger','web')),
  status       text not null default 'not_connected'
                 check (status in ('connected','not_connected','live')),
  config       jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

create unique index if not exists uq_channel_connections on channel_connections(business_id, channel_type);

-- ============================================================================
-- 7. Marketing: opt-ins, templates, campaigns
-- ============================================================================

create table if not exists opt_ins (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete cascade,
  channel_type        text not null check (channel_type in ('whatsapp','instagram','messenger')),
  customer_identifier text not null,
  consent_status      text not null default 'unknown'
                        check (consent_status in ('opted_in','opted_out','unknown')),
  source              text not null default 'inbound'
                        check (source in ('inbound','form','campaign','manual')),
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists uq_opt_ins on opt_ins(business_id, channel_type, customer_identifier);
create index if not exists idx_opt_ins_consent on opt_ins(business_id, channel_type, consent_status);

create table if not exists message_templates (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  channel_type text not null check (channel_type in ('whatsapp','instagram','messenger')),
  name         text not null,
  body         text not null,
  variables    jsonb not null default '[]'::jsonb,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists uq_templates on message_templates(business_id, channel_type, name);

create table if not exists campaigns (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  name          text not null,
  channel_type  text not null default 'whatsapp'
                  check (channel_type in ('whatsapp','instagram','messenger','web')),
  template_name text,
  target_segment text,
  scheduled_at  timestamptz,
  status        text not null default 'draft'
                  check (status in ('draft','scheduled','sent','failed')),
  sent_count    integer not null default 0,
  failed_count  integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_campaigns_due on campaigns(status, scheduled_at);

create table if not exists campaign_recipients (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete cascade,
  campaign_id         uuid not null references campaigns(id) on delete cascade,
  conversation_id     uuid references conversations(id) on delete set null,
  customer_identifier text not null,
  channel_type        text not null check (channel_type in ('whatsapp','instagram','messenger')),
  status              text not null default 'pending'
                        check (status in ('pending','sent','delivered','failed','opted_out')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists uq_campaign_recipient
  on campaign_recipients(campaign_id, customer_identifier);

create table if not exists compliance_checks (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  label       text not null,
  description text,
  passed      boolean not null default false,
  checked_at  timestamptz not null default now()
);

create index if not exists idx_compliance on compliance_checks(business_id, checked_at desc);

-- ============================================================================
-- 8. Agent behaviour settings
-- ----------------------------------------------------------------------------
-- One row per business. Drives the AI's greeting, tone and guardrails.
-- ============================================================================

create table if not exists agent_settings (
  business_id            uuid primary key references businesses(id) on delete cascade,
  greeting_message       text not null default 'Hi! How can I help you today?',
  formality              text not null default 'Neutral'
                           check (formality in ('Casual','Neutral','Formal')),
  emoji_enabled          boolean not null default false,
  clarification_cap      integer not null default 3,
  history_window         text not null default '20 messages / 24h',
  cart_abandon_threshold text not null default '1 hour',
  updated_at             timestamptz not null default now()
);

-- ============================================================================
-- 9. Row Level Security
-- ----------------------------------------------------------------------------
-- Every table is readable and writable only by agents of the owning business.
-- The server uses the service-role key, which bypasses RLS by design.
-- ============================================================================

create or replace function current_business_id() returns uuid as $$
  select business_id from agents
  where user_id = auth.uid()
  order by created_at asc
  limit 1;
$$ language sql stable security definer set search_path = public;

-- Turn RLS on for every table.
do $$
declare t text;
begin
  foreach t in array array[
    'businesses','agents','conversations','messages','products','orders',
    'order_items','carts','channels','channel_connections','opt_ins',
    'message_templates','campaigns','campaign_recipients','compliance_checks',
    'agent_settings'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Tenant tables: one policy each, "you may touch rows of your own business".
do $$
declare t text;
begin
  foreach t in array array[
    'conversations','messages','products','orders','carts','channels',
    'channel_connections','opt_ins','message_templates','campaigns',
    'campaign_recipients','compliance_checks','agent_settings'
  ] loop
    execute format('drop policy if exists "tenant access" on %I', t);
    execute format(
      'create policy "tenant access" on %I for all
         using (business_id = current_business_id())
         with check (business_id = current_business_id())', t);
  end loop;
end $$;

-- order_items has no business_id; it inherits access through its order.
drop policy if exists "tenant access" on order_items;
create policy "tenant access" on order_items for all
  using (exists (select 1 from orders o
                 where o.id = order_items.order_id
                   and o.business_id = current_business_id()))
  with check (exists (select 1 from orders o
                      where o.id = order_items.order_id
                        and o.business_id = current_business_id()));

-- businesses: read your own; insert is allowed so onboarding can bootstrap.
drop policy if exists "read own business" on businesses;
create policy "read own business" on businesses for select
  using (id = current_business_id());

drop policy if exists "create business" on businesses;
create policy "create business" on businesses for insert with check (true);

-- agents: a signed-in user may create their own row; teammates see each other.
drop policy if exists "self-provision own agent row" on agents;
create policy "self-provision own agent row" on agents for insert
  with check (user_id = auth.uid());

drop policy if exists "read team" on agents;
create policy "read team" on agents for select
  using (business_id = current_business_id());

drop policy if exists "update team" on agents;
create policy "update team" on agents for update
  using (business_id = current_business_id());

drop policy if exists "remove team" on agents;
create policy "remove team" on agents for delete
  using (business_id = current_business_id());

-- ============================================================================
-- 10. Onboarding
-- ----------------------------------------------------------------------------
-- Creates the business, the owner's agent row AND default agent settings in
-- one atomic SECURITY DEFINER transaction. Doing this client-side used to 403:
-- RLS filters the business INSERT ... RETURNING before any agent row exists,
-- so current_business_id() has nothing to match against yet.
-- ============================================================================

create or replace function create_business_and_agent(business_name text, agent_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_business_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into businesses (name) values (business_name)
  returning id into new_business_id;

  insert into agents (business_id, user_id, name, email, role)
  values (new_business_id, auth.uid(), agent_name,
          coalesce(auth.jwt() ->> 'email', ''), 'owner');

  insert into agent_settings (business_id) values (new_business_id)
  on conflict (business_id) do nothing;

  return new_business_id;
end;
$$;

grant execute on function create_business_and_agent(text, text) to authenticated;
grant usage on schema public to anon, authenticated;

-- ============================================================================
-- 11. Realtime
-- ----------------------------------------------------------------------------
-- Publish conversations and messages so the Inbox updates itself when a
-- customer writes, instead of only refreshing when the page is remounted.
--
-- RLS still applies to realtime: a subscriber receives only rows their own
-- policies would let them SELECT, so one business never sees another's
-- traffic. REPLICA IDENTITY FULL is needed for UPDATE payloads to carry the
-- old row, which is what lets the client tell a status change from a new row.
-- ============================================================================

alter table conversations replica identity full;
alter table messages replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table conversations;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table messages;
  exception when duplicate_object then null;
  end;
end $$;

-- ============================================================================
-- Done. Every table the dashboard queries now exists.
-- ============================================================================
