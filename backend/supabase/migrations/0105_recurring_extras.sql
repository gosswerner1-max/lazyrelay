-- Recurring schedules carry the same optional extras as a single post: tags,
-- extra images (multi-image / carousel) and a self-reply at N likes. Each
-- generated post gets whatever its platform supports (backend/src/postExtras.ts
-- extrasForPlatform); the rest is left out for that platform.

alter table recurring_schedules
  add column if not exists tags text[] not null default '{}',
  add column if not exists media_urls text[] not null default '{}',
  add column if not exists self_reply_text text,
  add column if not exists self_reply_at_likes integer;
