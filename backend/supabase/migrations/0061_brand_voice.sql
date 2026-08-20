-- Brand voice for AI captions/hashtags (2026-08-20) — the landing page's
-- own "How we label AI features" copy has said suggestions "aren't
-- personalized to your brand voice yet" since before this; this is that
-- feature. Two levels, both nullable, both optional:
--   accounts.voice_profile   — the default voice for a customer who
--                              doesn't use the Brands feature at all
--                              (the common single-business case).
--   brands.voice_profile     — an override for a specific brand, for
--                              customers running several (agencies,
--                              multi-business owners) — already-existing
--                              social_accounts.brand_id is what links a
--                              connected account to one of these.
alter table accounts add column voice_profile text null;
alter table brands add column voice_profile text null;
