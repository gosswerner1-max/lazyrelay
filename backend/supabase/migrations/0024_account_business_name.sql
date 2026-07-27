alter table accounts add column business_name text;

-- Signup passes the chosen name via Supabase auth's user metadata
-- (options.data.business_name in the frontend's signUp call) — pull it
-- straight into the new accounts row so it's there from the first request,
-- rather than requiring a separate "finish your profile" step.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounts (id, email, business_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'business_name');
  return new;
end;
$$;
