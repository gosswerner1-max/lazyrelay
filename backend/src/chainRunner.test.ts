import { describe, it, expect, vi } from "vitest";
import { runChain } from "./chainRunner.js";

const ok = (id: string) => ({ success: true, platformPostId: id, errorMessage: null });

describe("runChain", () => {
  it("posts each follow-up replying to the one before, in order", async () => {
    const calls: Array<{ root: string; parent: string; text: string }> = [];
    const adapter = {
      postChainReply: vi.fn(async (i: { rootPostId: string; parentPostId: string; text: string }) => {
        calls.push({ root: i.rootPostId, parent: i.parentPostId, text: i.text });
        return ok(`reply${calls.length}`);
      }),
    };
    const r = await runChain(adapter, { rootPostId: "main", texts: ["two", "three", "four"], accessToken: "t" });
    expect(r).toEqual({ posted: 3, error: null });
    expect(calls).toEqual([
      { root: "main", parent: "main", text: "two" },
      { root: "main", parent: "reply1", text: "three" },
      { root: "main", parent: "reply2", text: "four" },
    ]);
  });

  it("stops at the first refusal and says how far it got", async () => {
    let n = 0;
    const adapter = { postChainReply: async () => (++n === 2 ? { success: false, platformPostId: null, errorMessage: "Duplicate content" } : ok(`r${n}`)) };
    expect(await runChain(adapter, { rootPostId: "main", texts: ["a", "b", "c"], accessToken: "t" })).toEqual({ posted: 1, error: "Duplicate content" });
  });

  it("a throw is caught and reported, never propagated", async () => {
    const adapter = { postChainReply: async () => { throw new Error("network down"); } };
    expect(await runChain(adapter, { rootPostId: "main", texts: ["a"], accessToken: "t" })).toEqual({ posted: 0, error: "network down" });
  });

  it("reports plainly when the platform cannot do threads", async () => {
    expect(await runChain({}, { rootPostId: "main", texts: ["a"], accessToken: "t" })).toEqual({ posted: 0, error: "This platform cannot post a thread." });
  });

  it("does nothing for an empty chain", async () => {
    const adapter = { postChainReply: vi.fn() };
    expect(await runChain(adapter, { rootPostId: "main", texts: [], accessToken: "t" })).toEqual({ posted: 0, error: null });
    expect(adapter.postChainReply).not.toHaveBeenCalled();
  });
});
