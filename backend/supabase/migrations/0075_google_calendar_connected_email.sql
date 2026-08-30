-- Settings only ever showed "Connected." with no way to tell WHICH Google
-- account was linked (2026-08-30) -- a real gap once a customer's LazyRelay
-- login and their Google account aren't the same email, which won't always
-- be true for customers the way it wasn't for our own dogfooding account.
-- Nullable: existing connections (made before this column existed) show
-- "Connected." until they reconnect, same graceful-degradation as every
-- other additive nullable column in this codebase.
alter table google_calendar_connections add column connected_email text;
