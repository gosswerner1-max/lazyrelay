-- Opt-out switch for the instant-welcome-email trigger (0088), for TEST databases.
--
-- 0088 posts every new accounts row to the PRODUCTION backend. A throwaway Supabase branch built
-- from this folder carries the same trigger, so test accounts created there would post their ids
-- to production. This file adds a database setting that turns the post off.
--
-- TEST PROCEDURE: right after creating a Supabase branch, and BEFORE creating any test account,
-- run this on the branch, then reconnect (a new connection is needed to see it):
--
--   alter database postgres set app.signup_webhook_disabled = 'on';
--
-- Behaviour: the exact value 'on' makes the function return without posting. Unset, or any other
-- value, behaves exactly as 0088 did. Production never sets it, so production is unchanged.
-- This is opt-out discipline, not automatic isolation: a database cannot reliably tell that it
-- is a branch, so a branch where the step is forgotten still posts to production.
--
-- Everything else is copied from 0088 unchanged: same URL, headers, payload, timeout, error
-- handling, security definer and search_path. The trigger itself is not touched.

create or replace function public.notify_new_account_welcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.signup_webhook_disabled', true) = 'on' then
    return new;
  end if;
  begin
    perform net.http_post(
      url := 'https://lazyrelaylazyrelay-backend.onrender.com/api/webhooks/signup',
      body := jsonb_build_object('record', jsonb_build_object('id', new.id)),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 5000
    );
  exception when others then
    -- Never block a signup over an email. The hourly ops sweep will welcome
    -- this account instead.
    null;
  end;
  return new;
end;
$$;
