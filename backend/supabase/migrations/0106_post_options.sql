-- Platform-specific post options (master list #20): TikTok AI label, YouTube
-- visibility / made-for-kids / tags, Instagram and Facebook Stories, Instagram
-- trial reels, thread chains, LinkedIn PDF documents. One jsonb object per post,
-- validated in backend/src/postOptions.ts (each platform reads only its own key).
-- Recurring schedules carry the same object; each generated post keeps only the
-- key its platform reads.

alter table scheduled_posts add column if not exists options jsonb not null default '{}'::jsonb;
alter table recurring_schedules add column if not exists options jsonb not null default '{}'::jsonb;

-- How a thread chain went: how many follow-up posts were published, and the first
-- reason one was not (the main post is already live either way).
alter table post_results
  add column if not exists chain_posted integer,
  add column if not exists chain_error text;
