import { describe, it, expect, vi } from "vitest";

// Importing the knowledge pulls in modules that need a database client. Nothing here touches one.
vi.mock("../supabase.js", () => ({ supabase: { from: () => ({}) } }));

const { buildSupportSystemPrompt } = await import("./chatKnowledge.js");
const { getPlatformRules } = await import("../platformRules.js");

describe("support bot knowledge: platforms", () => {
  const prompt = buildSupportSystemPrompt(null);
  const line = (prompt.split("\n").find((l) => l.startsWith("PLATFORMS LazyRelay posts to today:")) ?? "");

  it("lists every platform LazyRelay can post to (X is described separately: own developer keys), Slack included", () => {
    // Nostr is built but switched off (NOSTR_PLATFORM_PUBLIC): like X, it is not listed to customers until release.
    const labels = getPlatformRules().filter((r) => r.platform !== "x" && r.platform !== "nostr" && r.platform !== "whop" && r.platform !== "whatsapp").map((r) => r.label);
    expect(labels).toContain("Slack");
    // A rules label can be longer than the name customers see (for example "Facebook Page"), so match its first word.
    for (const label of labels) expect(line, label).toContain(label.split(" ")[0]);
    expect(line.replace("PLATFORMS LazyRelay posts to today:", "").split(",").length).toBe(labels.length);
    expect(labels.length).toBe(17);
    // 17 listed here plus X (described separately) = the public "18 distribution platforms plus WhatsApp".
    expect(prompt).toContain("18 distribution platforms plus WhatsApp");
  });

  it("no longer says Slack is unreleased, and states its real limits", () => {
    expect(prompt).not.toMatch(/Slack is NOT released/i);
    expect(prompt).toMatch(/Slack \(added 2026-10-01\)/);
    expect(prompt).toContain("4,000 characters");
    expect(prompt).toMatch(/Private channels are not offered/);
  });

  it("does not list Whop yet, and says it is not released", () => {
    expect(line).not.toContain("Whop");
    expect(prompt).toMatch(/Whop is NOT released yet/);
  });

  it("does not list Nostr yet, and says it is not released", () => {
    expect(line).not.toContain("Nostr");
    expect(prompt).toMatch(/Nostr is NOT released yet/);
  });

  it("treats WhatsApp as live client messaging, not a distribution platform and not in the posting list", () => {
    expect(line).not.toContain("WhatsApp");
    expect(prompt).not.toMatch(/WhatsApp is NOT released yet/);
    expect(prompt).toMatch(/WhatsApp is client messaging/);
    expect(prompt).not.toMatch(/still being rolled out to their account/);
  });
});

describe("support bot knowledge: plans, credits and prices", () => {
  const prompt = buildSupportSystemPrompt(null);

  it("states the four plans with prices (plus tax), credits and caps", () => {
    expect(prompt).toContain("Free ($0)");
    expect(prompt).toMatch(/30 credits once at registration/);
    expect(prompt).toMatch(/3 connected accounts, 1 brand, 10 queued posts/);
    expect(prompt).toMatch(/Pay as you go \(\$15 one time, plus tax\): 300 credits that never expire, 20 connected accounts, 2 brands/);
    expect(prompt).toMatch(/Growth \(\$29 a month, plus tax\): 1,000 credits each billing cycle/);
    expect(prompt).toMatch(/30 connected accounts, 4 brands/);
    expect(prompt).toMatch(/Pro \(\$99 a month, plus tax\): 6,000 credits each billing cycle/);
    expect(prompt).toMatch(/1,000 connected accounts, unlimited brands/);
    expect(prompt).toMatch(/no rollover/);
  });

  it("states the credit packs and that the Pro top-up is Pro only", () => {
    expect(prompt).toMatch(/Starter pack \$15 for 300 credits/);
    expect(prompt).toMatch(/Growth pack \$50 for 1,500 credits/);
    expect(prompt).toMatch(/Pro top-up \$30 for 1,500 credits, available only to active Pro subscribers/);
  });

  it("states what actions cost and the spending rules", () => {
    expect(prompt).toMatch(/1 credit per channel destination/);
    expect(prompt).toMatch(/5 channels costs 5 credits/);
    expect(prompt).toMatch(/10 credits/);
    expect(prompt).toMatch(/failed teardown costs nothing/);
    expect(prompt).toMatch(/expire first are spent first/);
    expect(prompt).toMatch(/wallet is empty, due posts wait/);
  });

  it("no longer mentions the old six plans, their prices, or the old add-ons", () => {
    for (const old of ["59.99", "29.99", "99.99", "149.99", "199.99", "Agency", "Business (", "Starter ("]) expect(prompt, old).not.toContain(old);
    expect(prompt).not.toMatch(/extra storage|storage add-on|team seats? on|Seat/i);
    expect(prompt).not.toMatch(/\$10\/mo|5GB|20GB|50GB/);
  });

  it("uses no em or en dashes", () => {
    expect(prompt).not.toMatch(/[–—]/);
  });
});
