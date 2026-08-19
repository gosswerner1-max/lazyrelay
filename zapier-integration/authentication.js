const BASE_URL = process.env.LAZYRELAY_API_BASE_URL || "https://lazyrelaylazyrelay-backend.onrender.com/api";

// LazyRelay's own API key auth (see backend/src/http/auth.ts:182,
// resolveApiKey) — the same bearer token a customer generates themselves
// from the dashboard's API Keys tab (Settings). Paid-tier only
// (Starter/Pro/Business); a free-tier key is rejected by the backend
// itself with a 403, not by anything in this file.
const test = (z, bundle) => {
  return z.request({
    url: `${BASE_URL}/account`,
    method: "GET",
  });
};

module.exports = {
  type: "custom",
  fields: [
    {
      key: "apiKey",
      label: "API Key",
      required: true,
      type: "password",
      helpText:
        "Find or create this in your LazyRelay dashboard under Settings → API Keys. Requires a paid plan (Starter, Pro, or Business).",
    },
  ],
  test,
  connectionLabel: (z, bundle) => bundle.inputData.businessName || bundle.inputData.email || "LazyRelay account",
};
