-- Instant welcome email (2026-09-21, Werner's call). When a signup creates a
-- row in public.accounts, ping the backend's /api/webhooks/signup with the new
-- account's id. The backend (signupWebhook.ts) sends the welcome email within
-- seconds and marks accounts.welcome_email_sent_at (migration 0062). The
-- hourly ops sweep (ops/accounts/welcome_onboarding_ops.js) stays as the
-- safety net for anything this misses.
--
-- HARD REQUIREMENT: this must NEVER be able to break a signup. The last time
-- a change to the signup trigger chain slipped (0074 -> fixed by 0078), every
-- new customer got a broken account. So:
--   * the HTTP call is made with pg_net, which is asynchronous -- it queues
--     the request and returns immediately; signup does not wait on Render
--   * the call is wrapped in an exception handler that swallows every error
--     (pg_net missing, permission denied, anything) so the row insert and the
--     rest of handle_new_user() always complete
--   * the function is a plain AFTER INSERT trigger on accounts; it adds no
--     columns and changes no existing function
--
-- No secret is sent: the endpoint is safe by construction (it only acts on an
-- account id, reads the recipient from the database, and only for an
-- account created in the last 24h that has never been welcomed). See the
-- comment block in backend/src/http/signupWebhook.ts.

create extension if not exists pg_net;

create or replace function public.notify_new_account_welcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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

drop trigger if exists accounts_welcome_email_notify on public.accounts;
create trigger accounts_welcome_email_notify
  after insert on public.accounts
  for each row execute function public.notify_new_account_welcome();
