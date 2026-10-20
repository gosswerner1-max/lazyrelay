// Deliberate breakages of migration 0140 for `--selftest --selftest-break=<name>`. Each one must make the script FAIL, which shows the
// script can fail at all. (They break the logic, so they are caught even though PGlite serialises connections. Some need two edits
// because the database has a second line of defence: a check constraint, a unique index, or the sweep before the lot pick.)
export const BREAKS = {
  overdraft: {
    edits: [
      ["l.remaining_units - l.reserved_units as avail", "l.remaining_units as avail"],
      ["and l.remaining_units - l.reserved_units > 0\n  ), running", "and l.remaining_units > 0\n  ), running"],
    ],
    meaning: "(a) holds ignore what is already reserved",
  },
  idempotency: {
    edits: [["select * into v_existing from public.wallet_holds where account_id = p_account_id and idempotency_key = p_key;", "select * into v_existing from public.wallet_holds where false;"]],
    meaning: "(b) a repeated hold key is not recognised",
  },
  expiry: {
    edits: [
      ["(l.expires_at is null or l.expires_at > p_now) and l.remaining_units", "l.remaining_units"],
      ["expires_at is not null and expires_at <= p_now and remaining_units - reserved_units > 0\n    order by", "expires_at is not null and false\n    order by"],
    ],
    meaning: "(e) an expired lot can be spent",
  },
  grants: {
    edits: [["select * into v_lot from public.wallet_lots where account_id = p_account_id and source_key = p_source_key;", "select * into v_lot from public.wallet_lots where false;"]],
    meaning: "(d) a repeated source key is not recognised",
  },
  release: {
    edits: [["perform public.wallet_i_move(v_hold.breakdown, 'unreserve');\n  update public.wallet_holds set status = 'released'", "update public.wallet_holds set status = 'released'"]],
    meaning: "(c) and (g) a release keeps the reservation",
  },
};

export function breakSql(sql, name) {
  const b = BREAKS[name];
  if (!b) throw new Error(`unknown --selftest-break value; use one of ${Object.keys(BREAKS).join(", ")}`);
  let out = sql;
  for (const [find, replace] of b.edits) {
    if (!out.includes(find)) throw new Error(`break "${name}": text not found in the migration`);
    out = out.replace(find, () => replace);
  }
  return out;
}
