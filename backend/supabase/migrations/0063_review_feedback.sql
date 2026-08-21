-- Werner's call 2026-08-21: the review-request email (Template 12) used to
-- just ask "reply to this email with a quick line or two." Replaced with a
-- link to a small public star-rating form instead -- lower friction than
-- composing a reply, and gives structured signal (5 questions) instead of
-- free text alone.
--
-- token: mirrors account_members.invite_token's pattern (migration 0053) --
-- Postgres generates it, not app code, and it's the sole authorization for
-- the public GET/POST routes (no login involved, matches the anonymous
-- link-in-an-email use case).
-- Five separate rating columns rather than a jsonb blob -- same reasoning
-- as this schema's other explicit-column tables: a fixed, known question
-- set that's cheap to query/aggregate later, not a flexible/growing one.
create table review_feedback (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  token uuid not null default uuid_generate_v4(),
  rating_overall smallint check (rating_overall between 1 and 5),
  rating_reliability smallint check (rating_reliability between 1 and 5),
  rating_ease smallint check (rating_ease between 1 and 5),
  rating_support smallint check (rating_support between 1 and 5),
  rating_recommend smallint check (rating_recommend between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);

create unique index review_feedback_token_idx on review_feedback (token);

alter table review_feedback enable row level security;
-- No policies added -- deliberately service-role-only, same as every other
-- ops-only table in this schema (e.g. account_members, brand_addons). The
-- public routes use the backend's service-role Supabase client, same as
-- every other /public/* route already does.
