-- scheduled_posts has never tracked when a row was last modified — every
-- other timestamp on it (created_at, scheduled_for) is fixed at creation.
-- Needed as its own primitive by Google Calendar sync (last-write-wins
-- conflict resolution needs a real "when did our side last change" value to
-- compare against Google's own event.updated timestamp), but genuinely
-- useful on its own regardless of that feature.

alter table scheduled_posts add column updated_at timestamptz not null default now();

create or replace function touch_scheduled_posts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger scheduled_posts_touch_updated_at
  before update on scheduled_posts
  for each row execute function touch_scheduled_posts_updated_at();
