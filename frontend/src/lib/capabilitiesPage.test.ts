import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import page from "../../public/capabilities/index.html?raw";
import sitemap from "../../public/sitemap.xml?raw";
import llms from "../../public/llms.txt?raw";

// Guard for the public /capabilities page: every capability it lists is something the product does today (each line is checked against
// a source named below), the copy rules hold (no dash or hyphen in what a reader sees, no blue), the structured data is valid and says
// the same thing as the page, and the page is discoverable (sitemap, llms.txt).
//   Platforms: the live platform picker, 18 distribution platforms plus WhatsApp (Werner, 2026-10-16).
//   MCP: 27 tools (backend/src/mcp/lazyrelayTools.ts, lazyrelay-mcp.json), hosted endpoint plus local package.
//   Competitor teardown: 10 credits (backend/src/wallet/prices.ts, teardown.ts), Claude Sonnet 5.5 (engine DEFAULT_COMPETITOR_MODEL, claude-sonnet-5-5,
//   no override set on the live engine), structure only, blocked networks (engine input.ts), output fields and caps (engine blueprintSchema.ts).
//   Own keys: X_BYOK_ALLOWED_TIERS and WHATSAPP_BYOK_ALLOWED_TIERS in backend/src/tier.ts. Free plan: FACTS-2026-10-20.
//   WhatsApp: backend/src/whatsappBroadcast (broadcasts.ts, sender.ts, optOuts.ts, flags.ts), whatsappChat/chatSend.ts, whatsappChat/window.ts,
//   http/routes/whatsappRouteGate.ts, platforms/whatsapp/sendSupport.ts and optOutKeywords.ts.
//   Result record: the per destination post result (live flag and public URL). Nothing here claims it is append only, and the word ledger
//   is kept to the meta keywords tag the owner asked for.

const guard = createRequire(import.meta.url)("../../../scripts/check-copy-guardrails.js") as { checkHtml: (html: string) => string[] };
const URL_ = "https://lazyrelay.com/capabilities/";

const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
const software = blocks.find((b) => b["@type"] === "SoftwareApplication") as { featureList: string[]; offers: Record<string, string>; [k: string]: unknown };
const faq = blocks.find((b) => b["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
const visible = page.slice(page.indexOf("<body")).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the copy rules", () => {
  it("no dash or hyphen in what a reader sees, no blue anywhere, no blue leaning colour", () => {
    expect(guard.checkHtml(page)).toEqual([]);
  });
  it("the structured data text has no dash or hyphen either", () => {
    const text = JSON.stringify(blocks, (_k, v) => (typeof v === "string" && /^https?:\/\//.test(v) ? "" : v));
    expect(text).not.toMatch(/[-‐-―−]/);
  });
});

describe("the head", () => {
  it("has a canonical link, a robots tag and share tags that match", () => {
    expect(page).toContain(`<link rel="canonical" href="${URL_}" />`);
    expect(page).toContain('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />');
    const title = /<title>([^<]+)<\/title>/.exec(page)![1]!;
    const desc = /<meta name="description" content="([^"]+)"/.exec(page)![1]!;
    expect(title.length).toBeLessThanOrEqual(70);
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(page).toContain(`<meta property="og:title" content="${title}" />`);
    expect(page).toContain(`<meta property="og:description" content="${desc}" />`);
    expect(page).toContain(`<meta property="og:url" content="${URL_}" />`);
    expect(page).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(page.match(/<h1[ >]/g)).toHaveLength(1);
  });
});

describe("the structured data", () => {
  it("is a SoftwareApplication with a free offer and a feature list", () => {
    expect(software.name).toBe("LazyRelay");
    expect(software.url).toBe("https://lazyrelay.com");
    expect(software.applicationCategory).toBe("BusinessApplication");
    expect(software.operatingSystem).toBe("Web");
    expect(software.offers).toMatchObject({ "@type": "Offer", price: "0", priceCurrency: "USD" });
    expect(software.featureList.length).toBeGreaterThanOrEqual(5);
  });
  it("lists only features the page itself describes (each feature name appears in the visible text)", () => {
    for (const f of software.featureList) expect(visible.toLowerCase(), f).toContain(f.toLowerCase().split(":")[0]!.trim());
  });
  it("carries no invented rating, review count or price", () => {
    const json = JSON.stringify(blocks);
    expect(json).not.toMatch(/aggregateRating|ratingValue|reviewCount|"review"/);
    expect(json).not.toMatch(/\$\d/);
  });
  it("FAQ answers match the page and use the approved platform wording", () => {
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(4);
    const all = faq.mainEntity.map((q) => q.acceptedAnswer.text).join(" ");
    expect(all).toContain("18 distribution platforms plus WhatsApp");
    for (const q of faq.mainEntity) expect(visible).toContain(q.acceptedAnswer.text.replace(/&/g, "&"));
  });
});

describe("what it claims is true", () => {
  it.each([
    ["the approved platform wording", "18 distribution platforms plus WhatsApp"],
    ["WhatsApp is not counted as a distribution platform", "not one of the 18 distribution platforms"],
    ["27 MCP tools", "27 MCP tools"],
    ["Proof of Publish reads the post back", "reads it back from the platform"],
    ["a post is live only when confirmed", "marked live only when that read back confirms it"],
    ["the cost of a teardown", "A teardown costs 10 credits"],
    ["charged only on delivery", "charged only when the blueprint is delivered"],
    ["the model", "Claude Sonnet 5.5"],
    ["the page reader", "Firecrawl"],
    ["own keys plans", "Growth, Pro and Pay as you go"],
    ["the free plan", "30 credits once at registration"],
    ["a result record per destination with the live check and the public URL", "You get a result record for each destination. It shows whether the read back confirmed the post is live, and the public URL of the post."],
  ])("says %s", (_why, text) => {
    expect(visible).toContain(text);
  });
  it.each([
    [/split[ -]screen/i],
    [/Sonnet 3/i],
    [/tracker|tracking competitors/i],
    [/hook zone/i],
    [/absolute control/i],
    [/heavy messaging/i],
    [/programmatic data hook/i],
    [/silent (API )?drops/i],
    [/local (workspace )?files/i],
    [/brand settings/i],
    [/(17|19) (distribution )?platforms/i],
  ])("never says %s", (pattern) => {
    expect(visible).not.toMatch(pattern);
  });
  it.each([
    [/model[ -]agnostic/i],
    [/zero[ -]trust/i],
    [/without central (cloud )?database/i],
    [/Enterprise/i],
    [/shadow/i],
    [/guarantee/i],
    [/ #1 |number one|best in class|world.s (best|first)/i],
    [/aggregateRating/i],
    [/premier/i],
    [/real[ -]time/i],
    [/purg/i],
    [/zero central/i],
    [/transparency/i],
    [/out of the box/i],
  ])("never says %s", (pattern) => {
    expect(page).not.toMatch(pattern);
  });
  it("does not call the result record a ledger or claim it is append only, in the body, title, description or structured data", () => {
    const title = /<title>([^<]+)<\/title>/.exec(page)![1]!;
    const desc = /<meta name="description" content="([^"]+)"/.exec(page)![1]!;
    const text = [visible, title, desc, JSON.stringify(blocks)].join(" ");
    expect(text).not.toMatch(/ledger/i);
    expect(text).not.toMatch(/append[ -]only|immutable|tamper/i);
  });
  it("lists exactly the 18 distribution platforms", () => {
    for (const name of ["Facebook", "Instagram", "TikTok", "Pinterest", "YouTube", "LinkedIn", "Threads", "Mastodon", "Bluesky", "Telegram", "Discord", "Tumblr", "WordPress", "dev.to", "Hashnode", "Lemmy", "Slack", "X"]) {
      expect(visible, name).toContain(name);
    }
  });
});

describe("the WhatsApp section states what the code enables and no more", () => {
  const wa = visible.slice(visible.indexOf("(b) WhatsApp"), visible.indexOf("(c) Proof of Publish"));
  it.each([
    ["who can use it: any paid plan, not Free or lapsed (tier.ts WHATSAPP_BYOK_ALLOWED_TIERS, accountLimits.ts checkWhatsappPlan)", "Any paid plan: Growth, Pro or Pay as you go. Free accounts and accounts whose plan has lapsed cannot connect WhatsApp."],
    ["the customer's own Meta credentials, billed by Meta (byok.ts, adapter.ts)", "your own Meta WhatsApp Business account, phone number and access token"],
    ["no credits taken (tier.ts: meters nothing)", "LazyRelay takes no credits for WhatsApp messages and has no shared number"],
    ["dashboard only (whatsappRouteGate.ts humanRoute)", "All sending happens from the signed in dashboard."],
    ["broadcasts are approved templates, scheduled 1 minute to 30 days ahead, to opted in contacts of one number (broadcasts.ts)", "one message template that Meta has approved, scheduled between 1 minute and 30 days ahead, sent to the opted in contacts of one WhatsApp number"],
    ["replies need the 24 hour window; templates only to opted in saved contacts (chatSend.ts, window.ts)", "only while the 24 hour window after the customer's last message is open. Outside that window only an approved template can be sent, and only to a saved contact who opted in."],
    ["no marketing template to US numbers (broadcasts.ts, chatSend.ts us_marketing_blocked)", "A marketing template is never sent to a US number (+1)"],
    ["delivery only from Meta receipts, cost is an estimate (broadcasts.ts)", "as delivered only when Meta's own receipt says so. The cost shown is an estimate from the prices you enter."],
    ["no LazyRelay volume limit, a Meta restriction pauses the number (broadcasts.ts, sender.ts)", "LazyRelay sets no limit on how many messages you send. Meta's limits apply, and if Meta restricts your number, sending pauses until you resume it."],
    ["no post to WhatsApp through API, key, MCP, Zapier, bulk or duplicate (sendSupport.ts, flags.ts)", "A post cannot be sent to WhatsApp through the API, an API key, MCP, Zapier, bulk import or duplicate."],
    ["the opt out keywords (optOutKeywords.ts)", "STOP, UNSUBSCRIBE, CANCEL, END, QUIT, OPT OUT, OPTOUT or STOP ALL"],
    ["opt outs recorded and rechecked before every send (optOuts.ts, sender.ts)", "That record is checked again just before every send."],
    ["keywords need the customer's own webhook (whatsappWebhookInfo.routes.ts)", "Reply keywords are read once you point your own Meta app's webhook at LazyRelay."],
  ])("says %s", (_why, text) => {
    expect(wa).toContain(text);
  });
  it("does not promise anything the code does not do", () => {
    for (const pattern of [/guarantee/i, /unlimited/i, /free messages/i, /auto[ -]?repl/i, /chatbot/i, /SMS/]) expect(wa).not.toMatch(pattern);
  });
});

describe("the competitor analysis section states what the engine does and no more", () => {
  const comp = visible.slice(visible.indexOf("2. Pay As You Go"), visible.indexOf("3. Custom Developer Bridges"));
  it.each([
    ["10 credits, charged on delivery, nothing on failure (wallet/teardown.ts)", "A teardown costs 10 credits. The 10 credits are charged only when the blueprint is delivered, and a failed teardown costs nothing."],
    ["a consent box before anything is sent (CompetitorConsentDialog.tsx)", "You tick a consent box before anything is sent."],
    ["the page reader, main content, a cached copy up to a day (engine firecrawl.ts)", "main content only, and a copy up to a day old may be used"],
    ["public web pages only (engine input.ts, firecrawl.ts)", "Public web pages only. If the site does not allow the page to be read, the teardown stops there."],
    ["blocked networks (engine input.ts CLOSED_NETWORKS)", "Links to TikTok, Instagram, Facebook, X, Twitter, LinkedIn and Threads are not read, and neither are their short link addresses."],
    ["no video links (engine blueprint.ts)", "Video links are not supported: a YouTube link cannot be turned into a blueprint."],
    ["rate limits (engine limits.ts)", "a pause of at least 45 seconds between two of yours, a daily count per user and a daily ceiling across all users"],
    ["the model (engine anthropic.ts DEFAULT_COMPETITOR_MODEL = claude-sonnet-5-5)", "Analysis by Claude Sonnet 5.5"],
    ["structure only and the rejection rules (engine blueprintSchema.ts)", "It does not quote the page, and its answer is rejected if it holds a link, an @mention, a claim that the page performs well, or a copied run of eight words or more from the page."],
    ["hook types and note cap (blueprintSchema.ts HOOK_TYPES, MAX_HOOK_NOTE)", "question, statistic, bold claim, story, how to, list, problem and agitate, social proof, offer or other, with a note of up to 160 characters"],
    ["sections: up to 8, role 40, summary 140 (blueprintSchema.ts)", "Up to 8 sections in page order, each with a role label of up to 40 characters"],
    ["cta placement values and style cap (blueprintSchema.ts)", "its placement (top, middle, bottom, multiple or none), a style of up to 100 characters, and a count"],
    ["cta count and placement computed by LazyRelay (blueprintSchema.ts computed cta, structure.ts computeCta)", "LazyRelay counts and places the call to action links itself, so the placement and count do not come from the model."],
    ["three to six adjustments of up to 160 characters (blueprintSchema.ts)", "Three to six short adjustments of up to 160 characters each"],
    ["the analysis part: facts and a 280 character draft with one tag (engine analyze.ts, guard.ts)", "a draft post of up to 280 characters with one tag"],
  ])("says %s", (_why, text) => {
    expect(comp).toContain(text);
  });
  it("does not claim anything the engine does not do", () => {
    for (const pattern of [/guarantee/i, /performance score/i, /tracking competitors/i, /video (analysis|transcript)/i, /Sonnet 4/i, /Haiku|Opus/i]) expect(comp).not.toMatch(pattern);
  });
});

describe("it can be found", () => {
  it("is in the sitemap once", () => {
    expect(sitemap.split(URL_).length - 1).toBe(1);
  });
  it("has the five search phrases in the keywords tag", () => {
    const kw = /<meta name="keywords" content="([^"]+)"/.exec(page)![1]!;
    for (const k of ["usage-based social media scheduler", "pay-as-you-go competitor analysis", "Claude Code Model Context Protocol tools", "verified post distribution ledger", "landing page structure extraction"]) expect(kw).toContain(k);
  });
  it("is in llms.txt", () => {
    expect(llms).toContain(URL_);
  });
  it("links to the home page, pricing and the MCP guides", () => {
    for (const href of ['href="/"', 'href="/pricing/"', 'href="/mcp/"']) expect(page).toContain(href);
  });
});
