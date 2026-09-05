-- ============================================================================
-- Team access and per-shop limits.
--
-- Run once in Supabase → SQL Editor. Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Plans, so one shop's traffic cannot spend another shop's allowance
-- ---------------------------------------------------------------------------

alter table businesses add column if not exists plan text not null default 'free';
alter table businesses add column if not exists monthly_reply_limit integer not null default 500;

-- ---------------------------------------------------------------------------
-- 2. Invited teammates
--
-- An invite is an agents row with the email filled in and user_id still null.
-- It becomes a real membership the first time that person signs in, so an
-- invite can be sent before the person has an account and nothing has to be
-- reconciled by hand afterwards.
-- ---------------------------------------------------------------------------

create unique index if not exists uq_agents_business_email
  on agents(business_id, lower(email))
  where email <> '';

/**
 * Attach the signed-in user to any invite addressed to their email.
 *
 * SECURITY DEFINER on purpose: an invited person has no agents row yet, so
 * every tenant policy excludes them — they cannot see the invite that is for
 * them, let alone claim it. The function is the one narrow door through that,
 * and it only ever matches rows whose email equals the caller's own verified
 * address.
 */
create or replace function claim_invites() returns integer as $$
declare
  linked integer;
  caller_email text;
begin
  select email into caller_email from auth.users where id = auth.uid();
  if caller_email is null then
    return 0;
  end if;

  update agents
     set user_id = auth.uid()
   where user_id is null
     and lower(email) = lower(caller_email);

  get diagnostics linked = row_count;
  return linked;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function claim_invites() from public;
grant execute on function claim_invites() to authenticated;
