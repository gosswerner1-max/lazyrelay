-- Global daily backstop for POST /support/chat (2026-08-19 security review):
-- the route costs real Anthropic spend per call and had no cap beyond a
-- per-IP-per-minute rate limit, which is trivially multiplied across many
-- source IPs. One row per day; the function does the check-then-increment
-- atomically (same reasoning as increment_ai_generation_usage in 0028) so
-- concurrent requests near the cap can't both slip through a read-then-write
-- race. Returns true if this call is allowed to proceed (and has already
-- counted itself), false if today's cap is already reached.

create table support_chat_usage (
  usage_date date primary key,
  message_count integer not null default 0
);

alter table support_chat_usage enable row level security;
-- No policies for anon/authenticated -- only ever touched via the
-- function below, called by the backend's service-role client.

create function check_and_increment_support_chat_usage(p_usage_date date, p_daily_cap integer)
returns boolean
language plpgsql
security definer
as $$
declare
  current_count integer;
begin
  insert into support_chat_usage (usage_date, message_count)
  values (p_usage_date, 0)
  on conflict (usage_date) do nothing;

  select message_count into current_count
  from support_chat_usage
  where usage_date = p_usage_date
  for update;

  if current_count >= p_daily_cap then
    return false;
  end if;

  update support_chat_usage
  set message_count = message_count + 1
  where usage_date = p_usage_date;

  return true;
end;
$$;

revoke execute on function check_and_increment_support_chat_usage(date, integer) from public;
grant execute on function check_and_increment_support_chat_usage(date, integer) to service_role;
