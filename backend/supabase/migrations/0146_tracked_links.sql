-- Tracked links: first-party link redirection and click counting (2026-10-21, Werner approved the Link Tracking Engine for the Campaign clicks tab).
-- What it adds: a short code per tracked link (tied to the account, optionally to the dispatch that carried it, and to the channel it was
-- posted on) and one row per validated click. The backend route GET /r/:code looks the code up, records the click and sends the visitor on.
--
-- Privacy: nothing about the visitor is stored, not even a hash: no IP address, no user agent, no cookie, no identifier of any kind. Only raw
-- click volume is counted (Werner's decision, 2026-10-21: unique counting stays off for good, which keeps this outside POPIA's personal-information rules).
--
-- Safety: destination_url can only ever be an https page on lazyrelay.com or timeajob.com (checked here AND in the backend), so this can never
-- become an open redirect. Both tables are service-role only (RLS on, no policies), same reasoning as referral_click_counts (0118).

create table tracked_links (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Za-z0-9_-]{6,16}$'),
  account_id uuid not null references accounts(id) on delete cascade,
  scheduled_post_id uuid references scheduled_posts(id) on delete set null,
  platform text not null check (platform ~ '^[a-z0-9_]{2,30}$'),
  destination_url text not null check (destination_url ~ '^https://(www\.)?(lazyrelay|timeajob)\.com(/[^[:space:]]*)?$' and length(destination_url) <= 2048),
  created_at timestamptz not null default now()
);
create index tracked_links_account_idx on tracked_links (account_id, created_at desc);
create index tracked_links_post_idx on tracked_links (scheduled_post_id) where scheduled_post_id is not null;

create table link_clicks (
  id bigint generated always as identity primary key,
  link_id uuid not null references tracked_links(id) on delete cascade,
  clicked_at timestamptz not null default now()
);
create index link_clicks_link_idx on link_clicks (link_id, clicked_at desc);

alter table tracked_links enable row level security;
alter table link_clicks enable row level security;
-- No policies: service role only. A customer reads their numbers through GET /api/analytics/link-clicks, never the tables.
revoke all on tracked_links from public, anon, authenticated;
revoke all on link_clicks from public, anon, authenticated;

-- Record one click and return where to send the visitor. p_count = false resolves the link without counting (link-preview bots, HEAD requests).
-- An unknown code returns null (the backend then sends the visitor to the home page, never an error).
-- SECURITY DEFINER with execute for service_role only: a SECURITY DEFINER function must never stay executable by PUBLIC (lesson from 0118).
create or replace function record_link_click(p_code text, p_count boolean default true)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  l tracked_links%rowtype;
begin
  if p_code is null or p_code !~ '^[A-Za-z0-9_-]{6,16}$' then
    return null;
  end if;
  select * into l from tracked_links where code = p_code;
  if not found then
    return null;
  end if;
  if p_count then
    insert into link_clicks (link_id) values (l.id);
  end if;
  return l.destination_url;
end;
$$;

revoke execute on function record_link_click(text, boolean) from public, anon, authenticated;
grant execute on function record_link_click(text, boolean) to service_role;

-- Per-link totals for one account, for the Campaign clicks tab. The account id is ALWAYS supplied by the backend from the signed-in session,
-- never from the request. Brand comes from the connected account that carried the dispatch ("Unassigned" when there is none).
create or replace function link_clicks_summary(p_account_id uuid, p_since timestamptz, p_platform text default null, p_brand text default null)
returns table (
  code text, destination_url text, platform text, brand text, scheduled_post_id uuid, created_at timestamptz,
  clicks bigint, last_click timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.code, t.destination_url, t.platform,
    coalesce(sa.brand_label, 'Unassigned') as brand,
    t.scheduled_post_id, t.created_at,
    count(c.id) as clicks,
    max(c.clicked_at) as last_click
  from tracked_links t
  left join scheduled_posts sp on sp.id = t.scheduled_post_id
  left join social_accounts sa on sa.id = sp.social_account_id
  left join link_clicks c on c.link_id = t.id and c.clicked_at >= p_since
  where t.account_id = p_account_id
    and (p_platform is null or t.platform = p_platform)
    and (p_brand is null or coalesce(sa.brand_label, 'Unassigned') = p_brand)
  group by t.id, sa.brand_label
  order by clicks desc, t.created_at desc
  limit 200;
$$;

revoke execute on function link_clicks_summary(uuid, timestamptz, text, text) from public, anon, authenticated;
grant execute on function link_clicks_summary(uuid, timestamptz, text, text) to service_role;

-- Roll back: drop function link_clicks_summary(uuid, timestamptz, text, text); drop function record_link_click(text, boolean);
--            drop table link_clicks; drop table tracked_links;
