-- Storage bucket for post media (images/video attached to scheduled posts).
-- Public read (so a post's media_url is directly usable by platform APIs and
-- in the Dashboard's own preview) but all writes go through the backend's
-- service-role client (POST /media/upload) — customers never write to
-- storage directly, so no client-facing storage RLS policies are needed.
insert into storage.buckets (id, name, public)
values ('post-media', 'post-media', true)
on conflict (id) do nothing;
