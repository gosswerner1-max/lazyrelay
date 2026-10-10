// The public "MCP tools, webhooks and limits" developer page (frontend/public/docs/mcp-api/index.html), GENERATED so the tool names
// and descriptions in its catalogue are the ones lazyrelayTools.ts registers, never retyped. Written by
// backend/scripts/generate-mcp-api-page.ts; mcpApiPage.test.ts fails when the committed page is stale or when a fact on it no
// longer matches the code it was taken from (rate limit ladder in http/rateLimit.ts, webhook retry delays in webhook.ts, package
// versions in the package.json files).
//
// Copy rules for this page: only facts that can be read from the code or from what the live site already says; plain ASCII; no
// em or en dashes; no ranking, "uncapped", "zero" or "military grade" style claims.

import { MCP_FACTS, type CapturedTool } from "./mcpDocs.js";

/** The count the site states everywhere (frontend/src/lib/homeSchema.ts MCP_TOOL_COUNT). The generator fails if the server registers a different number. */
export const EXPECTED_TOOL_COUNT = 27;

/** How the tools are grouped on the page. Every registered tool must appear in exactly one group, or rendering throws. */
export const TOOL_GROUPS: Array<{ id: string; title: string; blurb: string; accent: string; tools: string[] }> = [
  {
    id: "accounts-lookups",
    title: "Accounts and lookups",
    blurb: "Find out what is connected and what each platform accepts before you post.",
    accent: "teal",
    tools: ["list_connected_accounts", "list_workspaces", "get_platform_rules", "get_tiktok_creator_info", "list_pinterest_boards", "get_next_free_slot", "list_posting_slots", "list_snippets"],
  },
  {
    id: "posting",
    title: "Posting",
    blurb: "Create, schedule, edit, pause and cancel posts.",
    accent: "orange",
    tools: ["schedule_post", "publish_post_now", "create_draft", "schedule_draft", "update_post", "reschedule_post", "pause_post", "resume_post", "delete_scheduled_post"],
  },
  {
    id: "client-approval",
    title: "Client approval",
    blurb: "Approve waiting posts and run client review links and feedback.",
    accent: "violet",
    tools: ["approve_post", "create_review_link", "list_review_links", "revoke_review_link", "get_post_feedback", "reply_to_post_feedback"],
  },
  {
    id: "results",
    title: "Results",
    blurb: "Check what happened: post status and Proof-of-Publish, shareable proof, analytics and comments.",
    accent: "green",
    tools: ["list_scheduled_posts", "get_proof_link", "get_analytics_summary", "get_mentions"],
  },
];

/** Requests per minute per account, by the PUBLIC plan name. Mirrors TIER_LIMITS in http/rateLimit.ts (the test reads that file). */
export const RATE_LIMIT_LADDER: Array<{ plan: string; perMinute: number }> = [
  { plan: "Free", perMinute: 60 },
  { plan: "Starter", perMinute: 300 },
  { plan: "Pro", perMinute: 450 },
  { plan: "Business", perMinute: 600 },
  { plan: "Agency", perMinute: 600 },
  { plan: "Agency Plus", perMinute: 600 },
];

/** Waits between webhook attempts, in the words the page uses. Mirrors RETRY_DELAYS_MS in webhook.ts (the test reads that file). */
export const WEBHOOK_RETRY_WAITS = ["1 minute", "5 minutes", "30 minutes", "2 hours", "6 hours"];

export interface PackageVersions {
  "@lazyrelay/mcp-server": string;
  "@lazyrelay/sdk": string;
  "n8n-nodes-lazyrelay": string;
}

const URL_ = "https://lazyrelay.com/docs/mcp-api/";
const TITLE = "MCP Tools, Webhooks and Rate Limits: Developer Docs | LazyRelay";
const DESCRIPTION = "Catalogue of LazyRelay's 27 MCP tools grouped by job, how webhooks are signed and retried, how the hosted MCP endpoint and API keys are secured, and the request limit for each plan.";
const API_BASE = "https://lazyrelaylazyrelay-backend.onrender.com/api";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function hints(t: CapturedTool): Array<{ label: string; kind: string }> {
  const out = [{ label: t.readOnly ? "read-only" : "changes data", kind: t.readOnly ? "read" : "write" }];
  if (t.destructive) out.push({ label: "destructive", kind: "danger" });
  if (t.idempotent) out.push({ label: "safe to repeat", kind: "safe" });
  if (t.openWorld) out.push({ label: "reaches a live platform", kind: "live" });
  return out;
}

function toolTable(tools: CapturedTool[], names: string[]): string {
  const rows = names.map((name) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`mcpApiPage: tool "${name}" is in TOOL_GROUPS but the server does not register it`);
    const chips = hints(t).map((h) => `<span class="chip chip-${h.kind}">${esc(h.label)}</span>`).join(" ");
    return `<tr><td class="tn"><a href="/mcp/tools/#${t.name}"><code>${t.name}</code></a></td><td class="th">${chips}</td><td class="td">${esc(t.description)}</td></tr>`;
  });
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Tool</th><th scope="col">Hints</th><th scope="col">Description</th></tr></thead><tbody>\n${rows.join("\n")}\n</tbody></table></div>`;
}

export function renderMcpApiPage(tools: CapturedTool[], versions: PackageVersions): string {
  const n = tools.length;
  if (n !== EXPECTED_TOOL_COUNT) throw new Error(`mcpApiPage: the server registers ${n} tools but the site states ${EXPECTED_TOOL_COUNT}. Update EXPECTED_TOOL_COUNT here, MCP_TOOL_COUNT in frontend/src/lib/homeSchema.ts and the copy on the site together.`);
  const grouped = TOOL_GROUPS.flatMap((g) => g.tools);
  const missing = tools.map((t) => t.name).filter((name) => !grouped.includes(name));
  const dupes = grouped.filter((name, i) => grouped.indexOf(name) !== i);
  if (missing.length || dupes.length || grouped.length !== n) throw new Error(`mcpApiPage: TOOL_GROUPS must list every tool exactly once (missing: ${missing.join(", ") || "none"}; repeated: ${dupes.join(", ") || "none"})`);

  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${URL_}#webpage`,
        url: URL_,
        name: "MCP tools, webhooks and rate limits",
        description: DESCRIPTION,
        inLanguage: "en",
        isPartOf: { "@id": "https://lazyrelay.com/#website" },
        about: { "@id": "https://lazyrelay.com/#software" },
        publisher: { "@id": "https://lazyrelay.com/#organization" },
      },
    ],
  }).replace(/</g, "\\u003c");

  const groups = TOOL_GROUPS.map(
    (g) => `<section class="group group-${g.accent}" id="${g.id}">
<h3>${esc(g.title)} <span class="count">${g.tools.length} tools</span></h3>
<p class="group-blurb">${esc(g.blurb)}</p>
${toolTable(tools, g.tools)}
</section>`,
  ).join("\n");

  const retryRows = WEBHOOK_RETRY_WAITS.map((w, i) => `<tr><td>${i + 1}</td><td>${w}</td></tr>`).join("\n");
  const rateRows = RATE_LIMIT_LADDER.map((r) => `<tr><td>${r.plan}</td><td>${r.perMinute} requests per minute</td></tr>`).join("\n");

  const sdkSnippet = `import express from "express";
import { verifyWebhookSignature } from "@lazyrelay/sdk";

const app = express();

app.post("/lazyrelay-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const ok = verifyWebhookSignature({
    secret: process.env.LAZYRELAY_WEBHOOK_SECRET,
    rawBody: req.body, // the raw bytes, before any JSON parsing
    signature: req.get("X-LazyRelay-Signature"),
  });
  if (!ok) return res.status(401).end();

  const event = JSON.parse(req.body.toString("utf8"));
  // X-LazyRelay-Delivery is the same on every retry of one event: use it to ignore a repeat.
  console.log(req.get("X-LazyRelay-Event"), event.eventId);
  res.status(200).end();
});`;

  const cryptoSnippet = `import { createHmac, timingSafeEqual } from "node:crypto";

function isValid(secret, rawBody, signatureHeader) {
  const received = String(signatureHeader || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}`;

  const css = `
  :root { color-scheme: light; --orange-text: #c82400; --teal: #0d7d8c; --teal-text: #0a6270; --violet: #7c3aed; --violet-text: #5b21b6; --green: #157a52; --green-text: #0f6b46; --ink: #14171f; --wire: #5b6472; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f5f6f8; color: #5b6472; margin: 0; line-height: 1.65; }
  header, footer { max-width: 960px; margin: 0 auto; padding: 24px; }
  main { max-width: 960px; margin: 0 auto; padding: 0 24px 48px; background: #fff; }
  .wordmark { display: flex; align-items: center; gap: 8px; font-family: Georgia, serif; font-weight: 700; font-size: 20px; color: var(--ink); text-decoration: none; }
  .wordmark .dot { color: var(--orange-text); }
  a { color: var(--orange-text); }
  a:focus-visible, summary:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; border-radius: 4px; }
  a.back { display: inline-block; margin: 8px 0 20px; text-decoration: none; }
  h1 { font-family: Georgia, serif; color: var(--ink); font-size: clamp(30px, 5vw, 40px); margin: 0 0 10px; line-height: 1.2; }
  h2 { font-family: Georgia, serif; color: var(--ink); font-size: 24px; margin: 48px 0 8px; padding-top: 10px; border-top: 6px solid var(--orange-text); }
  h3 { font-family: Georgia, serif; color: var(--ink); font-size: 19px; margin: 28px 0 6px; }
  .subtitle { color: var(--wire); font-size: 17px; margin: 0 0 18px; max-width: 720px; }
  .note { color: var(--wire); font-size: 14px; }
  strong { color: var(--ink); }
  ul, ol { padding-left: 22px; }
  li { margin-bottom: 8px; }
  code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; background: #f0f1f3; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: var(--ink); overflow-wrap: anywhere; }
  pre.code-block { background: #14171f; color: #e5e7eb; border-radius: 8px; padding: 14px 16px; overflow-x: auto; margin: 0 0 16px; font-size: 13px; line-height: 1.5; }
  pre.code-block code { background: none; padding: 0; color: #e5e7eb; white-space: pre; }
  .toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 8px; padding: 0; list-style: none; }
  .toc li { margin: 0; }
  .toc a { display: inline-block; background: #14171f; color: #fff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 7px 14px; border-radius: 999px; }
  .toc a:hover { background: var(--orange-text); }
  .toc a:focus-visible { outline-color: var(--orange-text); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0 4px; font-size: 14px; }
  .table-wrap { overflow-x: auto; margin: 0 0 8px; -webkit-overflow-scrolling: touch; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; min-width: 560px; }
  th, td { text-align: left; border-bottom: 1px solid #dde1e6; padding: 9px 10px; vertical-align: top; }
  th { color: var(--ink); background: #f5f6f8; }
  td.tn { white-space: nowrap; }
  td.th { min-width: 140px; }
  td.td { min-width: 260px; }
  .simple-table table { min-width: 0; max-width: 520px; }
  .chip { display: inline-block; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px; margin: 1px 0; white-space: nowrap; }
  .chip-read { background: #d6f3f6; color: #0a6270; }
  .chip-write { background: #ffe9a8; color: #6b4300; }
  .chip-danger { background: #ffd9d6; color: #8a1c14; }
  .chip-safe { background: #d4f2e4; color: #0f6b46; }
  .chip-live { background: #ece4fd; color: #5b21b6; }
  .group { border-left: 8px solid; padding-left: 14px; margin: 24px 0; }
  .group h3 { margin-top: 0; }
  .group .count { font-family: system-ui, sans-serif; font-size: 13px; font-weight: 700; color: var(--wire); margin-left: 6px; }
  .group-blurb { margin: 0 0 10px; }
  .group-teal { border-color: var(--teal); }
  .group-orange { border-color: #ff5630; }
  .group-violet { border-color: var(--violet); }
  .group-green { border-color: var(--green); }
  .card-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 12px 0; }
  .card { border: 2px solid #14171f; border-radius: 12px; padding: 14px 16px; background: #fff; }
  .card h3 { margin: 0 0 6px; font-size: 17px; }
  .card p { margin: 0 0 6px; font-size: 14px; }
  .cta-box { background: #f5f6f8; border-left: 4px solid #ff5630; padding: 20px 24px; margin: 32px 0; border-radius: 4px; }
  .cta-box a.button { display: inline-block; background: #c82400; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 700; margin-top: 8px; }
  @media (max-width: 640px) { .card-row { grid-template-columns: 1fr; } main { padding: 0 16px 40px; } header, footer { padding: 16px; } }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(TITLE)}</title>
<meta name="description" content="${esc(DESCRIPTION)}" />
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />
<link rel="canonical" href="${URL_}" />
<link rel="icon" type="image/png" href="/favicon.png" />
<meta property="og:title" content="${esc(TITLE)}" />
<meta property="og:description" content="${esc(DESCRIPTION)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${URL_}" />
<meta property="og:site_name" content="LazyRelay" />
<meta property="og:locale" content="en_US" />
<meta property="og:image" content="https://lazyrelay.com/og-image-1200x630.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(TITLE)}" />
<meta name="twitter:description" content="${esc(DESCRIPTION)}" />
<meta name="twitter:image" content="https://lazyrelay.com/og-image-1200x630.jpg" />
<link rel="stylesheet" href="/circuit-bg.css" />
<script src="/consent.js" defer></script>
<style>${css}</style>
<script type="application/ld+json">${ld}</script>
</head>
<body>
<script src="/circuit-bg.js" defer></script>
<header><a class="wordmark" href="/">Lazy<span class="dot">Relay</span></a></header>
<main>
<a class="back" href="/docs/">&larr; Back to API &amp; MCP docs</a>
<h1>MCP tools, webhooks and limits</h1>
<p class="subtitle">A reference for developers and AI agents: the ${n} MCP tools grouped by job, how outbound webhooks are signed and retried, how the hosted MCP endpoint and API keys are secured, and the request limit for each plan. Install steps are not repeated here.</p>
<ul class="toc">
  <li><a href="#tools">${n} MCP tools</a></li>
  <li><a href="#security">Security primitives</a></li>
  <li><a href="#rate-limits">Rate limits</a></li>
  <li><a href="#links">Links and packages</a></li>
</ul>
<p class="note">Looking for setup? <a href="/docs/">REST API and MCP reference</a> &middot; <a href="/mcp/">Setup guides for 15 AI tools</a> &middot; <a href="/mcp/tools/">Full input schemas for every tool</a> &middot; <a href="/developers/">LazyRelay for developers</a></p>

<h2 id="tools">The ${n} MCP tools</h2>
<p>Names and descriptions below are generated from the server's own tool definitions, so they are exactly what an AI agent receives. Each name links to its full input schema in the <a href="/mcp/tools/">MCP tool reference</a>. The hints are the MCP annotations each tool declares, so a client can decide what to confirm with you.</p>
<div class="legend" aria-label="Hint legend">
  <span class="chip chip-read">read-only</span> <span class="chip chip-write">changes data</span> <span class="chip chip-danger">destructive</span> <span class="chip chip-safe">safe to repeat</span> <span class="chip chip-live">reaches a live platform</span>
</div>
${groups}

<h2 id="security">Security primitives</h2>
<p>Only what the code does today.</p>

<h3 id="webhooks">Outbound webhooks</h3>
<p>LazyRelay can send an HTTP POST to an endpoint you register when something happens to a post or a connected account. You can register up to 5 endpoints in the dashboard under <strong>Settings, Webhooks</strong>; each has its own secret, shown once when it is created, and can be limited to chosen events and channels.</p>
<div class="table-wrap simple-table"><table><thead><tr><th scope="col">Event</th><th scope="col">Sent when</th></tr></thead><tbody>
<tr><td><code>post.verified</code></td><td>A post was confirmed live by the Proof-of-Publish check</td></tr>
<tr><td><code>post.failed</code></td><td>A post did not go out</td></tr>
<tr><td><code>post.unconfirmed</code></td><td>A post went out but could not be confirmed live</td></tr>
<tr><td><code>channel.needs_reconnect</code></td><td>A connected account needs to be reconnected</td></tr>
</tbody></table></div>
<p>The JSON body holds <code>event</code>, <code>eventId</code> and <code>createdAt</code> plus the details of the event. The dashboard's Send test button sends <code>webhook.test</code>, once, with no retries.</p>
<p><strong>Headers on every delivery</strong></p>
<ul>
<li><code>X-LazyRelay-Signature</code>: the HMAC-SHA256 of the raw JSON body, keyed with the endpoint secret, as lowercase hex with no prefix.</li>
<li><code>X-LazyRelay-Event</code>: the event name, for example <code>post.verified</code>.</li>
<li><code>X-LazyRelay-Delivery</code>: the event id. It is the same on every retry of one event, so use it to ignore a repeat.</li>
<li><code>X-LazyRelay-Attempt</code>: 1 on the first try, up to 6.</li>
</ul>
<p><strong>Delivery and retries.</strong> Each attempt times out after 10 seconds. A 2xx answer counts as delivered. A 408, a 429, any 5xx and a connection error or timeout are retried; any other answer, including a redirect (redirects are never followed), is a final failure you can read in the delivery log. There are 6 attempts in total, over about 9 hours, with these waits after each failed attempt:</p>
<div class="table-wrap simple-table"><table><thead><tr><th scope="col">After failed attempt</th><th scope="col">Wait before the next one</th></tr></thead><tbody>
${retryRows}
</tbody></table></div>
<p><strong>Verify the signature</strong> against the raw body, before any JSON parsing, because re-serialising parsed JSON can change whitespace or key order. With the Node SDK (<code>@lazyrelay/sdk</code>), which compares in constant time:</p>
<pre class="code-block"><code>${esc(sdkSnippet)}</code></pre>
<p>Without the SDK, the same check with Node's built-in crypto:</p>
<pre class="code-block"><code>${esc(cryptoSnippet)}</code></pre>

<h3 id="hosted-mcp">The hosted MCP endpoint</h3>
<ul>
<li><strong>Transport.</strong> <code>${esc(MCP_FACTS.hostedUrl)}</code> speaks MCP over Streamable HTTP in stateless mode: every request gets a fresh server and transport, so concurrent calls never share state.</li>
<li><strong>Authentication.</strong> OAuth 2.1 bearer tokens only. Each token is verified against the identity provider's published signing keys (JWKS), with the algorithm pinned to ES256, and must have been issued for the MCP server itself. An ordinary dashboard session token is rejected there.</li>
<li><strong>Discovery.</strong> The OAuth protected resource metadata (RFC 9728) is published under <code>/.well-known</code> on the same host, and an unauthenticated call gets a 401 with a <code>WWW-Authenticate</code> header pointing to it, which is how an MCP client finds the sign-in flow.</li>
<li><strong>Rate limit.</strong> Applied after authentication, per account, using the ladder below.</li>
</ul>

<h3 id="api-keys">REST API keys</h3>
<ul>
<li>Keys start with <code>lzr_live_</code> and are sent as <code>Authorization: Bearer</code>. They work on the REST API and in the local <code>@lazyrelay/mcp-server</code> package, not on the hosted <code>/mcp</code> endpoint.</li>
<li>A key is shown once, when you create it. LazyRelay stores only its SHA-256 hash.</li>
<li>A key cannot create or revoke keys: that always needs a direct dashboard sign-in.</li>
</ul>

<h2 id="rate-limits">Rate limits</h2>
<p>Requests are counted per account in a one minute window. The same ladder applies to authenticated REST API requests and to the hosted MCP endpoint. Over the limit, the API answers HTTP 429, and an MCP tool reports the error kind <code>rate_limited</code> with <code>retryable</code> set to true. A plan change can take up to a minute to apply.</p>
<div class="table-wrap simple-table"><table><thead><tr><th scope="col">Plan</th><th scope="col">Limit per account</th></tr></thead><tbody>
${rateRows}
</tbody></table></div>
<p class="note">This limits request volume only. Plan limits on accounts, brands and posts are separate; see <a href="/pricing">pricing</a>.</p>

<h2 id="links">Links and packages</h2>
<div class="card-row">
  <div class="card"><h3>OpenAPI 3.1</h3><p>The whole REST API as one public document, no key needed.</p><p><a href="${esc(MCP_FACTS.openApi)}">${esc(MCP_FACTS.openApi)}</a></p><p>API base URL: <code>${esc(API_BASE)}</code></p></div>
  <div class="card"><h3>@lazyrelay/mcp-server ${esc(versions["@lazyrelay/mcp-server"])}</h3><p>The local MCP server, run with <code>npx -y @lazyrelay/mcp-server</code> and an API key.</p><p><a href="https://www.npmjs.com/package/@lazyrelay/mcp-server">npm package</a></p></div>
  <div class="card"><h3>@lazyrelay/sdk ${esc(versions["@lazyrelay/sdk"])}</h3><p>Typed Node client, command line tool and the webhook signature helper. MIT licensed.</p><p><a href="https://www.npmjs.com/package/@lazyrelay/sdk">npm package</a></p></div>
  <div class="card"><h3>n8n-nodes-lazyrelay ${esc(versions["n8n-nodes-lazyrelay"])}</h3><p>The n8n community node and trigger node.</p><p><a href="https://www.npmjs.com/package/n8n-nodes-lazyrelay">npm package</a> &middot; <a href="/mcp/n8n/">n8n guide</a></p></div>
</div>

<div class="cta-box">
  <p style="margin-top:0;"><strong>Start free, no card required.</strong> API, MCP and SDK access is included on every plan, including Free.</p>
  <a class="button" href="/pricing">See plans and get started free</a>
</div>

</main>
<footer>
  <p><a href="/">Home</a> &middot; <a href="/about/">About</a> &middot; <a href="/guides">Guides</a> &middot; <a href="/pricing">Pricing</a> &middot; <a href="/docs">API &amp; MCP Docs</a> &middot; <a href="/developers/">Developers</a> &middot; <a href="/terms">Terms of Service</a> &middot; <a href="/privacy">Privacy Policy</a></p>
  <p class="note">&copy; 2026 LazyRelay. All rights reserved.</p>
</footer>
</body>
</html>
`;
}
