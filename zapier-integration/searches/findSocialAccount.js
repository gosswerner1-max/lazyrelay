const BASE_URL = process.env.LAZYRELAY_API_BASE_URL || "https://lazyrelaylazyrelay-backend.onrender.com/api";

// Visible Zapier "search" step — lets a Zap author look up a connected
// social account mid-Zap (e.g. "find the Mastodon account, then post to
// it") without hardcoding an id. Wraps the same GET /social-accounts
// endpoint as the hidden dropdown trigger in ../triggers/listSocialAccounts.js
// — that one exists only because Zapier's dynamic-dropdown mechanism
// requires a trigger, not a search; this one is the actual user-facing
// "Find Social Account" component.
const perform = async (z, bundle) => {
  const response = await z.request({
    url: `${BASE_URL}/social-accounts`,
    method: "GET",
  });

  let accounts = response.data || [];
  if (bundle.inputData.platform) {
    accounts = accounts.filter((a) => a.platform === bundle.inputData.platform);
  }
  if (bundle.inputData.displayName) {
    const needle = bundle.inputData.displayName.toLowerCase();
    accounts = accounts.filter((a) => (a.display_name || "").toLowerCase().includes(needle));
  }

  return accounts;
};

module.exports = {
  key: "find_social_account",
  noun: "SocialAccount",
  display: {
    label: "Find Social Account",
    description: "Finds a connected social account by platform and/or name.",
  },
  operation: {
    perform,
    inputFields: [
      {
        key: "platform",
        label: "Platform",
        type: "string",
        required: false,
        // The real, live-registered platform values (backend/src/platforms/registry.ts) —
        // NOT the same as the CHECK constraint's historical union, which
        // still lists a dead "meta" value from before the 2026-08 split
        // into separate "facebook"/"instagram" adapters (registry.ts:70-72).
        // "meta" is deliberately excluded here since no adapter registers
        // it any more; a real account can never actually have that value.
        choices: [
          "tiktok", "pinterest", "youtube", "mastodon", "bluesky", "telegram",
          "linkedin", "threads", "facebook", "instagram", "discord", "tumblr",
          "x", "snapchat", "google-business",
        ],
        helpText: "Leave blank to search across every connected platform.",
      },
      { key: "displayName", label: "Account Name Contains", type: "string", required: false },
    ],
    sample: {
      id: "3f2b1a90-8c7d-4e6f-9a1b-2c3d4e5f6a7b",
      platform: "mastodon",
      platform_account_id: "109876543210",
      display_name: "@mybrand",
      connected_at: "2026-06-01T00:00:00.000Z",
      brand_label: null,
      brand_id: null,
    },
  },
};
