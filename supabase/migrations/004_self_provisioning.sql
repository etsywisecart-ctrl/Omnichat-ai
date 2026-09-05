-- ============================================================================
-- Set the shop up during sign-in, instead of asking for it afterwards.
--
-- Run once in Supabase → SQL Editor. Safe to run more than once.
-- ============================================================================

/**
 * Resolve the signed-in user to a business, creating one if that is what the
 * situation calls for.
 *
 * Three ways someone arrives with no membership, and only one of them is
 * "ask them to fill in a form":
 *
 *   1. They were invited before they had an account — claim that invite.
 *   2. They signed up and named their business on the way in — create it.
 *   3. Neither — return null, and the app asks.
 *
 * Doing this in one SECURITY DEFINER call rather than a screen matters
 * because the screen is where people fall out: a signup that ends in a
 * confirmed account with no shop leaves someone signed in with nothing
 * working and no way forward. This deployment already has three of those.
 *
 * SECURITY DEFINER is required and safe here: a user with no agents row is
 * excluded by every tenant policy, so they cannot see the invite addressed to
 * them or insert their own membership. The function only ever acts on the
 * caller's own auth.uid() and their own verified email.
 */
create or replace function ensure_business()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  found_id uuid;
  caller_email text;
  wanted_business text;
  wanted_name text;
begin
  if auth.uid() is null then
    return null;
  end if;

  -- Already a member: nothing to do. Checked first so this is cheap and
  -- idempotent on every sign-in.
  select business_id into found_id
    from agents
   where user_id = auth.uid()
   order by created_at asc
   limit 1;

  if found_id is not null then
    return found_id;
  end if;

  select email, raw_user_meta_data ->> 'business_name', raw_user_meta_data ->> 'full_name'
    into caller_email, wanted_business, wanted_name
    from auth.users
   where id = auth.uid();

  -- Invited before they had an account.
  update agents
     set user_id = auth.uid()
   where user_id is null
     and caller_email is not null
     and lower(email) = lower(caller_email);

  select business_id into found_id
    from agents
   where user_id = auth.uid()
   order by created_at asc
   limit 1;

  if found_id is not null then
    return found_id;
  end if;

  -- Named their business at signup: build it now rather than showing a form
  -- that asks for something they have already typed.
  if wanted_business is not null and length(trim(wanted_business)) > 0 then
    insert into businesses (name) values (trim(wanted_business))
    returning id into found_id;

    insert into agents (business_id, user_id, name, email, role)
    values (
      found_id,
      auth.uid(),
      coalesce(nullif(trim(coalesce(wanted_name, '')), ''), split_part(coalesce(caller_email, 'there'), '@', 1)),
      coalesce(caller_email, ''),
      'owner'
    );

    insert into agent_settings (business_id) values (found_id)
    on conflict (business_id) do nothing;

    return found_id;
  end if;

  -- Nothing to go on. The app asks, which is now the exception rather than
  -- the route everyone takes.
  return null;
end;
$$;

revoke all on function ensure_business() from public;
grant execute on function ensure_business() to authenticated;
