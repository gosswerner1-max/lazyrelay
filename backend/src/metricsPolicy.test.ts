import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeBuilder, tables } from "./testFakeSupabase.js";
import { withoutByokXReads } from "./metricsPolicy.js";

const db = { from: (t: string) => makeBuilder(t) } as never;
const cand = (platform: string, socialAccountId: string) => ({ platform, socialAccountId, platformPostId: `p-${socialAccountId}` });

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.social_accounts = [
    { id: "xByok", platform: "x", credential_mode: "byok" },
    { id: "xOld", platform: "x", credential_mode: "platform" },
    { id: "bsky", platform: "bluesky", credential_mode: "platform" },
  ];
});

describe("metrics polling and X bring-your-own-key", () => {
  it("never polls a BYOK X account, but still polls a platform-credential account and every other platform", async () => {
    const kept = await withoutByokXReads([cand("x", "xByok"), cand("x", "xOld"), cand("bluesky", "bsky")], db);
    expect(kept.map((c) => c.socialAccountId)).toEqual(["xOld", "bsky"]);
  });

  it("does not even look at the column when no X candidate exists", async () => {
    const spy = vi.fn(() => makeBuilder("social_accounts"));
    const kept = await withoutByokXReads([cand("bluesky", "bsky")], { from: spy } as never);
    expect(kept).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("if the mode cannot be read, X is skipped (no spend) and others still go ahead", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: "boom" } }) }) }) } as never;
    const kept = await withoutByokXReads([cand("x", "xByok"), cand("x", "xOld"), cand("bluesky", "bsky")], failing);
    expect(kept.map((c) => c.socialAccountId)).toEqual(["bsky"]);
  });
});
