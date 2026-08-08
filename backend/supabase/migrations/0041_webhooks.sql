-- Proof-of-Publish webhook (2026-08-08) — item 5 from the 2026-08-07
-- competitor audit's "my own ideas" list: let a technical customer (or one
-- already using Zapier/n8n/Make) wire "post confirmed live" into their own
-- systems without building a dashboard integration.
--
-- One webhook per account (matches the solo-operator persona this product
-- targets — no need for a multi-endpoint webhook manager). webhook_secret
-- is stored in plaintext, not hashed, because the server needs the actual
-- value to HMAC-sign every outgoing delivery — this is the same shape every
-- outbound-webhook provider uses (Stripe, GitHub, Paddle, including
-- LazyRelay's own MOR_WEBHOOK_SECRET for inbound Paddle webhooks); it isn't
-- a downgrade from api_keys' hashed pattern, which exists to verify
-- INBOUND bearer tokens, a different threat model.
alter table accounts add column webhook_url text;
alter table accounts add column webhook_secret text;
