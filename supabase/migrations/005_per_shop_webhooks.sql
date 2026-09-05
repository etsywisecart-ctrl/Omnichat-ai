-- ============================================================================
-- Per-shop Meta credentials.
--
-- Run once in Supabase → SQL Editor. Safe to run more than once.
-- ============================================================================

-- The webhook used one verify token, one app secret and one business id from
-- environment variables, so every shop's inbound WhatsApp message was
-- attributed to whichever business that variable named. These columns let each
-- shop carry its own, and let a delivery be traced back to the shop it is for.
alter table channels add column if not exists verify_token text;
alter table channels add column if not exists app_secret text;

-- Meta identifies the destination in the payload — a phone number id, a page
-- id, or an Instagram account id. These are how an incoming message finds its
-- shop, so they have to be unique across the whole deployment, not per shop.
create unique index if not exists uq_channels_phone_number
  on channels(phone_number_id) where phone_number_id is not null;

create unique index if not exists uq_channels_page
  on channels(page_id) where page_id is not null;

create unique index if not exists uq_channels_instagram
  on channels(instagram_business_account_id)
  where instagram_business_account_id is not null;

create index if not exists idx_channels_verify_token
  on channels(verify_token) where verify_token is not null;
