// Headless Google Search Console query for lazyrelay.com, via the
// `search-console-reader` service account (Google Cloud project
// `lazyrelay-ops`, added as a Restricted user on the sc-domain property
// 2026-09-24). No googleapis/OAuth library -- raw JWT signing + fetch,
// same pattern as every other adapter in this codebase.
// Usage: node search_console_query.js [days] -- defaults to last 28 days.
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const keyPath = path.join(__dirname, "..", "config", "search-console-service-account.local.json");
const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key.private_key);
  const jwt = `${unsigned}.${b64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json.access_token;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const days = Number(process.argv[2]) || 28;
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3); // Search Console data usually lags 2-3 days
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);

  const token = await getAccessToken();
  const site = encodeURIComponent("sc-domain:lazyrelay.com");
  const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      startDate: isoDate(start),
      endDate: isoDate(end),
      dimensions: ["query"],
      rowLimit: 25,
    }),
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
