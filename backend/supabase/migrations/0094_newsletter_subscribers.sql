-- Newsletter signup, gated to reveal a discount code (2026-09-29) -- Werner's
-- own idea, separate from the referral/partner program: someone who isn't
-- coming through a partner (organic traffic, ads) can still get the launch
-- discount by giving their email for a real, low-volume "what's new" list
-- (Werner's own words: "no spam only updates and what is new"). This table
-- is that list -- no newsletter-sending system is built here, just the
-- capture + one-time discount-code delivery. Sending the actual periodic
-- updates is Werner's own future, ongoing content decision, not something
-- this migration or its route implies exists yet.
create table newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  subscribed_at timestamptz not null default now(),
  -- Set once someone unsubscribes -- the row is kept, not deleted, so a
  -- repeat signup attempt with the same email can be told "you're already
  -- on the list" (if still subscribed) or cleanly re-subscribed (if not),
  -- without a duplicate row either way.
  unsubscribed_at timestamptz,
  -- A real unsubscribe link needs a token, not just the row id -- an id is
  -- guessable/enumerable (uuid v4 isn't practically guessable, but this
  -- keeps the unsubscribe link's authority scoped to exactly this table's
  -- own purpose rather than reusing the row's primary key as a bearer
  -- token for something else later).
  unsubscribe_token text not null default encode(gen_random_bytes(24), 'hex')
);

-- Case-insensitive uniqueness, same convention as the case-insensitive
-- unique index on lower(business_name) (migration 0074) -- prevents a
-- customer signing up twice with different casing of the same address.
create unique index newsletter_subscribers_email_lower_idx on newsletter_subscribers (lower(email));
create unique index newsletter_subscribers_unsubscribe_token_idx on newsletter_subscribers (unsubscribe_token);

alter table newsletter_subscribers enable row level security;
-- No policies -- service-role only, same reasoning as referral_partners:
-- an internal marketing list, never read by an authenticated customer
-- directly, and the public routes that touch it (subscribe/unsubscribe)
-- go through the service-role client, not RLS.
