-- Anonymous per-day partner link click counts (2026-10-08, partner program step 6, Werner approved). Applied from this file.
-- What it adds: an anonymous, per-day count of how many times each partner's link was opened, split by the optional channel word
-- (utm_content, for example "youtube"). Nothing personal is stored: no IP address, no cookie, no user agent, no account id.
-- That keeps it outside POPIA's personal-information rules and means a partner can be shown "clicks" without being shown anyone's data.
--
-- What it does NOT do: it does not decide who gets paid. Money still follows the checkout-verified columns from migration 0093
-- (accounts.partner_code_redeemed / partner_code_redeemed_at). Clicks are only a funnel number for the partner and for Werner.

create table referral_click_counts (
  code text not null references referral_partners(code) on delete cascade,
  day date not null,
  channel text not null default '' check (channel ~ '^[a-z0-9_-]{0,30}$'),
  clicks integer not null default 0 check (clicks >= 0),
  primary key (code, day, channel)
);

alter table referral_click_counts enable row level security;
-- No policies: service role only, same reasoning as referral_partners (internal table, never read by a customer directly).
revoke all on referral_click_counts from public, anon, authenticated;

-- One atomic +1. SECURITY DEFINER because the backend calls it with the service role, and the lesson recorded in this repo is that a
-- SECURITY DEFINER function must never stay executable by PUBLIC, so execute is revoked from everyone but service_role below.
-- An unknown, paused or typo'd code is silently ignored (a stale link must never produce an error for a visitor).
create or replace function record_referral_click(p_code text, p_channel text default '')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c text := lower(nullif(trim(p_code), ''));
  ch text := lower(coalesce(nullif(trim(p_channel), ''), ''));
begin
  if c is null or ch !~ '^[a-z0-9_-]{0,30}$' then
    return;
  end if;
  if not exists (select 1 from referral_partners where lower(code) = c and status = 'approved') then
    return;
  end if;
  insert into referral_click_counts as t (code, day, channel, clicks)
  select rp.code, (now() at time zone 'utc')::date, ch, 1 from referral_partners rp where lower(rp.code) = c
  on conflict (code, day, channel) do update set clicks = t.clicks + 1;
end;
$$;

revoke execute on function record_referral_click(text, text) from public, anon, authenticated;
grant execute on function record_referral_click(text, text) to service_role;

-- Roll back: drop function record_referral_click(text, text); drop table referral_click_counts;
