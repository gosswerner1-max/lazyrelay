// The one shared way an ACCOUNT ITSELF is removed (accounts row + auth.users row). Extracted 2026-10-21 from
// abandoned_account_ops.js so the inactivity purge (inactivity_purge_ops.js) uses exactly the same removal and there is
// never a second implementation to drift. Content (posts, media) is the caller's job: data_retention_ops.js's
// deleteAccountData removes that. Every error is thrown raw; nothing is swallowed.

/** Deletes account_members rows (as owner and as a member), subscriptions rows, the accounts row (everything else with an
 * account_id cascades from it), and finally the auth.users row through the admin API. Order matters and is unchanged from the
 * original abandoned-account code. The caller must already have verified that deleting this account is allowed. */
async function deleteAccountRows(supabase, accountId) {
  const { error: membersError } = await supabase
    .from("account_members")
    .delete()
    .or(`account_id.eq.${accountId},user_id.eq.${accountId}`);
  if (membersError) throw membersError;

  const { error: subsError } = await supabase.from("subscriptions").delete().eq("account_id", accountId);
  if (subsError) throw subsError;

  const { error: accountError } = await supabase.from("accounts").delete().eq("id", accountId);
  if (accountError) throw accountError;

  const { error: authError } = await supabase.auth.admin.deleteUser(accountId);
  if (authError) throw authError;
}

module.exports = { deleteAccountRows };
