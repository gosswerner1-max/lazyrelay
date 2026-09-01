-- POST /public/signup/check-business-name is unauthenticated and fires on
-- every keystroke batch during signup (see api.ts's
-- checkBusinessNameAvailability: "called as the customer types ... and once
-- more right before submit"). It previously read EVERY non-null
-- business_name into memory per call. That was a deliberate choice, not an
-- oversight -- building a PostgREST OR-filter out of untrusted names is
-- genuinely fragile, since commas and parens are filter syntax and business
-- names can contain both.
--
-- A function sidesteps the hazard entirely rather than walking into it:
-- every candidate is a bound value, no filter string is ever assembled, and
-- the lookup rides accounts_lower_business_name_idx (migration 0074)
-- instead of scanning the table. Rows read per anonymous request goes from
-- "every account with a name" to at most 6 index hits.
--
-- The response shape is deliberately identical to what the old JS produced
-- ({available} / {available, reason, suggestions}) so the frontend needs no
-- change -- see the return type on api.ts's checkBusinessNameAvailability.
create or replace function check_business_name_available(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trimmed     text := btrim(p_name);
  v_base        text;
  v_suffix      text;
  v_candidates  text[];
  v_lowered     text[];
  v_taken       text[];
  v_suggestions text[] := '{}';
  n int;
begin
  if v_trimmed = '' then
    return jsonb_build_object('available', true);
  end if;

  -- Index 1 is the requested name; 2..6 are the numeric-suffix fallbacks,
  -- each truncated to fit the column's own 80-char limit. Same candidates
  -- the old JS loop generated, in the same order.
  v_candidates := array[v_trimmed];
  for n in 2..6 loop
    v_suffix := ' ' || n::text;
    v_base := case when length(v_trimmed) + length(v_suffix) > 80
                   then left(v_trimmed, 80 - length(v_suffix))
                   else v_trimmed end;
    v_candidates := v_candidates || (v_base || v_suffix);
  end loop;

  select array_agg(lower(x)) into v_lowered from unnest(v_candidates) as x;

  -- One indexed lookup covering all six candidates at once.
  select coalesce(array_agg(lower(business_name)), '{}')
    into v_taken
    from accounts
   where business_name is not null
     and lower(business_name) = any (v_lowered);

  if not (lower(v_trimmed) = any (v_taken)) then
    return jsonb_build_object('available', true);
  end if;

  -- array_length on an empty array is NULL, so the exit condition stays
  -- false until the first suggestion lands -- intentional, not a bug.
  for n in 2..array_length(v_candidates, 1) loop
    exit when array_length(v_suggestions, 1) >= 3;
    if not (lower(v_candidates[n]) = any (v_taken)) then
      v_suggestions := v_suggestions || v_candidates[n];
    end if;
  end loop;

  return jsonb_build_object(
    'available', false,
    'reason', 'taken',
    'suggestions', to_jsonb(v_suggestions)
  );
end;
$$;

-- Functions grant EXECUTE to public by default. This one must stay
-- backend-only: reachable by anon it would be the same name-enumeration
-- oracle the route is, minus the route's rate limiter.
revoke all on function check_business_name_available(text) from public;
revoke all on function check_business_name_available(text) from anon;
revoke all on function check_business_name_available(text) from authenticated;
grant execute on function check_business_name_available(text) to service_role;
