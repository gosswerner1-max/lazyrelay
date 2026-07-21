-- Every test so far created the accounts row manually via the service-role
-- client. A real signup through the frontend has no such step — without
-- this trigger, a freshly signed-up user would hit RLS-denied errors on
-- every subsequent request, since accounts has no INSERT policy for
-- authenticated users (deliberately, per least-privilege) and nothing
-- else would ever create that row.

create function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounts (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
