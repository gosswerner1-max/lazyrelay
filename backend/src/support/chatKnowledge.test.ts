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
    const labels = getPlatformRules().filter((r) => r.platform !== "x" && r.platform !== "nostr" && r.platform !== "whop").map((r) => r.label);
    expect(labels).toContain("Slack");
    // A rules label can be longer than the name customers see (for example "Facebook Page"), so match its first word.
    for (const label of labels) expect(line, label).toContain(label.split(" ")[0]);
    expect(line.replace("PLATFORMS LazyRelay posts to today:", "").split(",").length).toBe(labels.length);
    expect(labels.length).toBe(17);
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
});
