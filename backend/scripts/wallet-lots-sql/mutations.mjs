// Deliberate breakages of migration 0140. Each one must make at least the check named in `expect` fail (a substring of its name).
// edits: [find, replace] pairs applied to the migration text (a missing `find` is an error in this file, not a pass).
// append: extra SQL put after the migration (it runs both times the migration is applied).

const HANDLE_IMMEDIATE = "return public.wallet_i_revoke(p_account_id, p_plan, p_now, p_event, p_key, p_now, false);";
const HANDLE_VOLUNTARY = "return public.wallet_i_revoke(p_account_id, p_plan, p_period_end, p_event, p_key, p_now, true);";
const HANDLE_EVENTS = "if p_event is null or p_event not in ('past_due_retry', 'billing_gave_up', 'voluntary_cancel', 'chargeback', 'refund', 'admin_termination') then";

export const MUTATIONS = [
  { name: "pick lots no longer refuses a short request", expect: "zero overdraft", edits: [["and r.total >= p_units and", "and"]] },
  { name: "bucket order ignores expiry (oldest first)", expect: "bucket order: expiring lots first", edits: [["order by (l.expires_at is null), l.expires_at, l.granted_at, l.id) as rn", "order by l.granted_at, l.id) as rn"]] },
  { name: "bucket order spends the newest non-expiring lot first", expect: "bucket order: with only non-expiring", edits: [["l.granted_at, l.id) as rn", "l.granted_at desc, l.id) as rn"]] },
  { name: "an expired lot can be spent", expect: "never spent after its expires_at", edits: [["(l.expires_at is null or l.expires_at > p_now) and l.remaining_units", "l.remaining_units"]] },
  { name: "a hold debits instead of reserving", expect: "a hold reserves credits without debiting", edits: [["perform public.wallet_i_move(v_breakdown, 'reserve');", "perform public.wallet_i_move(v_breakdown, 'debit');"]] },
  { name: "a hold ignores credits already reserved", expect: "two sequential holds", edits: [["l.remaining_units - l.reserved_units as avail", "l.remaining_units as avail"]] },
  { name: "commit frees the reservation instead of debiting", expect: "commit debits exactly", edits: [["perform public.wallet_i_move(v_hold.breakdown, 'commit');", "perform public.wallet_i_move(v_hold.breakdown, 'unreserve');"]] },
  { name: "release keeps the reservation", expect: "release frees the reservation", edits: [["perform public.wallet_i_move(v_hold.breakdown, 'unreserve');\n  update public.wallet_holds set status = 'released'", "update public.wallet_holds set status = 'released'"]] },
  { name: "hold expiry keeps the reservation", expect: "hold expiry frees", edits: [["perform public.wallet_i_move(h.breakdown, 'unreserve');", "null;"]] },
  { name: "a hold replay is not recognised", expect: "idempotent replay of hold", edits: [["select * into v_existing from public.wallet_holds where account_id = p_account_id and idempotency_key = p_key;", "select * into v_existing from public.wallet_holds where false;"]] },
  { name: "a grant replay is not recognised", expect: "idempotent replay of hold", edits: [["select * into v_lot from public.wallet_lots where account_id = p_account_id and source_key = p_source_key;", "select * into v_lot from public.wallet_lots where false;"]] },
  { name: "a reused charge key is never a conflict", expect: "idempotency_conflict", edits: [["if v_existing.kind <> 'charge' or v_existing.action_type <> p_action or v_existing.units <> p_units then", "if false then"]] },
  { name: "the sweep expires nothing", expect: "wallet_expire writes one expire entry", edits: [["expires_at is not null and expires_at <= p_now and remaining_units - reserved_units > 0\n    order by", "expires_at is not null and false\n    order by"]] },
  { name: "the sweep also expires non-expiring lots", expect: "never touches non-expiring", edits: [["where account_id = p_account_id and expires_at is not null and expires_at <= p_now and remaining_units - reserved_units > 0\n    order by", "where account_id = p_account_id and (expires_at is null or expires_at <= p_now) and remaining_units - reserved_units > 0\n    order by"]] },
  { name: "the sweep ignores the reservation of a hold in flight", expect: "a hold placed before its lot expired", edits: [["select id, remaining_units - reserved_units as amt from public.wallet_lots", "select id, remaining_units as amt from public.wallet_lots"]] },
  { name: "the sweep writes a wrong running balance", expect: "random operations", edits: [["values (p_account_id, 'expire', -r.amt, v_balance,", "values (p_account_id, 'expire', -r.amt, v_balance + 1,"]] },
  { name: "a second signup grant is allowed", expect: "signup grant once only", edits: [["if p_kind = 'signup' and exists (select 1 from public.wallet_lots where account_id = p_account_id and kind = 'signup') then", "if false then"], ["create unique index if not exists wallet_lots_one_signup on public.wallet_lots (account_id) where kind = 'signup';", ""]] },
  { name: "the ledger is no longer append only", expect: "append only", append: "drop trigger if exists wallet_ledger_no_update_delete on public.wallet_ledger;" },
  { name: "anon may run a charge", expect: "anon and signed in customers cannot run", append: "grant execute on function public.wallet_charge(uuid, text, integer, text) to anon;" },
  { name: "the service role may run the bucket order function", expect: "internal helpers", append: "grant execute on function public.wallet_pick_lots(uuid, bigint, timestamptz) to service_role;" },
  { name: "every member can read every lot", expect: "a member reads only their own", append: "drop policy if exists wallet_lots_leak on public.wallet_lots; create policy wallet_lots_leak on public.wallet_lots for select to authenticated using (true);" },
  { name: "the browser may insert lots", expect: "the browser cannot write", append: "grant insert on public.wallet_lots to authenticated; drop policy if exists wallet_lots_w on public.wallet_lots; create policy wallet_lots_w on public.wallet_lots for insert to authenticated with check (true);" },
  { name: "the migration is not idempotent", expect: "the migration is idempotent", append: "update public.wallet_prices set price_micro = price_micro + 1 where action_type = 'post_publish';" },
  { name: "the migration wipes 0139 balances", expect: "0139 rows survive", append: "update public.wallet_accounts set balance_micro = 0;" },
  { name: "charge no longer takes the account lock", expect: "account row lock", edits: [["v_balance := public.wallet_i_lock(p_account_id);\n  select * into v_existing from public.wallet_ledger", "v_balance := 0;\n  select * into v_existing from public.wallet_ledger"]] },
  { name: "the Pro Top-Up gate is disabled", expect: "the Pro Top-Up gate", edits: [["if v_pack.requires_plan is not null and p_active_plan is distinct from v_pack.requires_plan", "if false and p_active_plan is distinct from v_pack.requires_plan"]] },
  { name: "a SKU grants the wrong amount", expect: "each SKU grants exactly", edits: [["v_pack.credits::bigint * 1000000", "v_pack.credits::bigint * 1000"]] },
  { name: "a subscription SKU lot does not expire", expect: "each SKU grants exactly", edits: [["case when v_pack.kind = 'subscription' then p_period_end else null end", "null::timestamptz"]] },
  { name: "the plan binding is never set", expect: "cancel now (lapse_at = now)", edits: [["coalesce(v_pack.requires_plan, v_pack.grants_plan)", "null::text"]] },
  { name: "revoke does not expire anything", expect: "cancel now (lapse_at = now)", edits: [["where account_id = p_account_id and bound_plan = p_plan and remaining_units > 0", "where false and account_id = p_account_id and bound_plan = p_plan and remaining_units > 0"]] },
  { name: "revoke ignores a lapse in the future (expires at once)", expect: "cancel at the period end", edits: [["v_effective := greatest(p_lapse_at, p_now);", "v_effective := p_now;"]] },
  { name: "revoke does not see its own earlier call", expect: "revoke replay", edits: [["select * into v_event from public.wallet_plan_events where account_id = p_account_id and idempotency_key = p_key;", "select * into v_event from public.wallet_plan_events where false;"]] },
  { name: "revoke accepts a lapse time months away", expect: "revoke replay", edits: [["or p_lapse_at > p_now + interval '40 days' then raise exception 'wallet_revoke_plan", "then raise exception 'wallet_revoke_plan"]] },
  { name: "release does not expire units freed on a lapsed lot", expect: "a hold in flight at the lapse", edits: [["update public.wallet_holds set status = 'released', resolved_at = now() where id = v_hold.id;\n  perform public.wallet_i_sweep(v_account, now());", "update public.wallet_holds set status = 'released', resolved_at = now() where id = v_hold.id;"]] },
  { name: "past_due_retry lapses the plan", expect: "past_due_retry is a no-op", edits: [["if p_event = 'past_due_retry' then return jsonb_build_object('ok', true, 'outcome', 'no_lapse'); end if;", `if p_event = 'past_due_retry' then ${HANDLE_IMMEDIATE} end if;`]] },
  { name: "billing_gave_up and the other immediate events lapse a day late", expect: "billing_gave_up lapses the plan", edits: [[HANDLE_IMMEDIATE, "return public.wallet_i_revoke(p_account_id, p_plan, p_now + interval '1 day', p_event, p_key, p_now, false);"]] },
  { name: "chargeback, refund and admin_termination lapse a day late", expect: "chargeback, refund and admin_termination", edits: [[HANDLE_IMMEDIATE, "return public.wallet_i_revoke(p_account_id, p_plan, p_now + interval '1 day', p_event, p_key, p_now, false);"]] },
  { name: "voluntary_cancel lapses at once instead of at period_end", expect: "voluntary_cancel mid-cycle", edits: [[HANDLE_VOLUNTARY, "return public.wallet_i_revoke(p_account_id, p_plan, p_now, p_event, p_key, p_now, true);"]] },
  { name: "voluntary_cancel accepts a period_end in the past", expect: "voluntary_cancel needs a period_end", edits: [["if p_period_end is null or p_period_end <= p_now or p_period_end > p_now + interval '40 days' then", "if p_period_end is null or p_period_end > p_now + interval '40 days' then"]] },
  { name: "an unknown event is not refused", expect: "unknown event name is refused", edits: [[HANDLE_EVENTS, "if false then"]] },
];

export function applyMutation(sql, m) {
  let out = sql;
  for (const [find, replace] of m.edits ?? []) {
    if (!out.includes(find)) throw new Error(`mutation "${m.name}": text to break not found: ${find.slice(0, 60)}`);
    out = out.replace(find, () => replace);
  }
  return out + (m.append ? `\nbegin;\n${m.append}\ncommit;\n` : "");
}
