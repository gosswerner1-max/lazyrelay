const BASE_URL = process.env.LAZYRELAY_API_BASE_URL || "https://lazyrelaylazyrelay-backend.onrender.com/api";

// Hidden trigger, not user-facing — only exists to power the
// "Social Account" dynamic dropdown on the Schedule Post action below.
// Zapier's `dynamic` field on an input field can only reference a trigger
// (hidden or not), never a search — that's a platform constraint, not a
// choice. The visible "Find Social Account" search in
// ../searches/findSocialAccount.js wraps the same endpoint for the
// separate case of a Zap author explicitly searching mid-Zap; the two
// exist for different Zapier mechanics, not by accident.
// Wraps GET /social-accounts (backend/src/http/routes.ts:1116), which
// already excludes disconnected accounts (`disconnected_at is null`).
const perform = async (z, bundle) => {
  const response = await z.request({
    url: `${BASE_URL}/social-accounts`,
    method: "GET",
  });

  return (response.data || []).map((account) => ({
    id: account.id,
    label: account.brand_label
      ? `${account.platform} — ${account.display_name} (${account.brand_label})`
      : `${account.platform} — ${account.display_name}`,
  }));
};

module.exports = {
  key: "list_social_accounts",
  noun: "SocialAccount",
  display: {
    label: "List Social Accounts",
    description: "Used internally to populate the Social Account dropdown.",
    hidden: true,
  },
  operation: {
    type: "polling",
    perform,
    sample: {
      id: "3f2b1a90-8c7d-4e6f-9a1b-2c3d4e5f6a7b",
      label: "mastodon — @mybrand",
    },
  },
};
