import { describe, it, expect } from "vitest";
import { planFeedCheck } from "./rssPoller.js";

const item = (n: number) => ({ id: `g${n}`, title: `t${n}`, link: "" });
const feed = [item(3), item(2), item(1)]; // newest first, like a real feed

describe("planFeedCheck", () => {
  it("the first check only learns what is there: no drafts", () => {
    const p = planFeedCheck(feed, [], false, 5);
    expect(p.newItems).toEqual([]);
    expect([...p.seenIds].sort()).toEqual(["g1", "g2", "g3"]);
  });
  it("later checks draft only unseen items, oldest first", () => {
    const p = planFeedCheck([item(5), item(4), ...feed], ["g1", "g2", "g3"], true, 5);
    expect(p.newItems.map((i) => i.id)).toEqual(["g4", "g5"]);
  });
  it("never drafts the same item twice", () => {
    const first = planFeedCheck([item(4), ...feed], ["g1", "g2", "g3"], true, 5);
    const again = planFeedCheck([item(4), ...feed], first.seenIds, true, 5);
    expect(again.newItems).toEqual([]);
  });
  it("respects the cap and leaves the rest for the next check", () => {
    const items = [item(8), item(7), item(6), item(5), item(4)];
    const p = planFeedCheck(items, [], true, 2);
    expect(p.newItems.map((i) => i.id)).toEqual(["g4", "g5"]);
    expect(p.seenIds).not.toContain("g6");
    const next = planFeedCheck(items, p.seenIds, true, 2);
    expect(next.newItems.map((i) => i.id)).toEqual(["g6", "g7"]);
  });
  it("makes no drafts when the account has no room", () => {
    expect(planFeedCheck([item(9)], [], true, 0).newItems).toEqual([]);
  });
  it("keeps the memory bounded", () => {
    const many = Array.from({ length: 400 }, (_, i) => `old${i}`);
    expect(planFeedCheck([item(1)], many, true, 5).seenIds.length).toBeLessThanOrEqual(300);
  });
});
