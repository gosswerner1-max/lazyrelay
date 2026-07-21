-- Tables created via raw SQL don't automatically get the base GRANTs that
-- Supabase's dashboard Table Editor applies for you. RLS policies only
-- take effect AFTER base table permissions are checked — service_role
-- bypasses RLS, but still needs an explicit GRANT to touch the tables at all.

grant usage on schema public to service_role, authenticated, anon;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- authenticated/anon get table-level access too, but RLS policies (already
-- in 0001) are what actually restrict them to their own rows.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;

-- Make sure this applies to tables created in future migrations too.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
