-- Link-in-bio pages — one public page per account (e.g. lazyrelay.com/bio/
-- <slug>) listing a customer's own links, the kind of page a customer puts
-- in their Instagram/TikTok bio. Same RLS shape as every other table here:
-- locked to service_role, no anon/authenticated policies — the public read
-- goes through a backend route (GET /public/bio/:slug, not behind
-- requireAuth) rather than exposing the table directly to anon, same
-- pattern as the OAuth callback route.

create table bio_pages (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null unique references accounts(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  title text not null default '',
  bio text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table bio_pages enable row level security;
grant all on bio_pages to service_role;

create index bio_pages_slug_idx on bio_pages (slug);

create table bio_links (
  id uuid primary key default uuid_generate_v4(),
  bio_page_id uuid not null references bio_pages(id) on delete cascade,
  label text not null,
  url text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

alter table bio_links enable row level security;
grant all on bio_links to service_role;

create index bio_links_page_idx on bio_links (bio_page_id, position);
