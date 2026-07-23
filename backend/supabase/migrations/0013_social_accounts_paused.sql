-- Adds real pause enforcement for social_accounts, closing the schema gap
-- documented in ops/accounts/accounts_ops.js's planDowngradePause(): a
-- downgrade past the new tier's connected-account limit should pause the
-- extra accounts (stop posting to them), never delete/disconnect them, so
-- they resume automatically on re-upgrade. paused_at is deliberately
-- separate from disconnected_at — disconnecting revokes the platform
-- connection entirely; pausing just withholds posting rights while the
-- connection (and its stored tokens) stays intact.
alter table social_accounts add column paused_at timestamptz;
