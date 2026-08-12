-- Supports a real "pick which Page/account to connect" step for platforms
-- where one OAuth login can map to several destinations (a Facebook user
-- can manage multiple Pages; Instagram posting goes through whichever Page
-- has a Business Account linked). Previously the app silently auto-picked
-- whichever the platform API returned first — this reuses the existing
-- oauth_states row (already scoped to the right account, already has a
-- built-in expiry) to hold the candidate list + the long-lived user token
-- (vault-encrypted, same as every other token this codebase stores) while
-- the customer picks, instead of a brand new table.

alter table oauth_states add column pending_options jsonb;
alter table oauth_states add column pending_token_vault_id uuid references vault.secrets(id);
