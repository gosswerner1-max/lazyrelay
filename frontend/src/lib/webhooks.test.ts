import { describe, it, expect } from "vitest";
import { describeChannels, describeDelivery, describeEvents, describeLastDelivery, eventLabel } from "./webhooks";

const ALL = ["post.verified", "post.failed", "post.unconfirmed", "channel.needs_reconnect"];
const fmt = (iso: string) => `at ${iso.slice(0, 10)}`;

describe("describeEvents", () => {
  it("empty or complete means all events", () => {
    expect(describeEvents([], ALL)).toBe("All events");
    expect(describeEvents(ALL, ALL)).toBe("All events");
  });
  it("lists a chosen subset in plain words", () => {
    expect(describeEvents(["post.failed", "channel.needs_reconnect"], ALL)).toBe("Post failed, Account needs reconnecting");
  });
  it("an event it has no label for is shown as it is", () => {
    expect(eventLabel("brand.new")).toBe("brand.new");
  });
});

describe("describeChannels", () => {
  const channels = [
    { id: "a", label: "Pinterest: LazyRelay" },
    { id: "b", label: "Threads: shop" },
  ];
  it("null or empty means every channel", () => {
    expect(describeChannels(null, channels)).toBe("All channels");
    expect(describeChannels([], channels)).toBe("All channels");
  });
  it("names the chosen ones, and copes with a channel that was disconnected", () => {
    expect(describeChannels(["b"], channels)).toBe("Threads: shop");
    expect(describeChannels(["a", "gone"], channels)).toBe("Pinterest: LazyRelay, a removed channel");
  });
});

describe("describeLastDelivery", () => {
  it("says nothing was sent yet", () => {
    expect(describeLastDelivery(null)).toEqual({ text: "Nothing sent yet", tone: "none" });
  });
  it("good, retrying and failed are told apart", () => {
    const base = { createdAt: "2026-10-01T08:00:00Z", statusCode: 500, error: "The endpoint answered 500." };
    expect(describeLastDelivery({ ...base, status: "delivered" }, fmt)).toEqual({ text: "Last delivery worked (at 2026-10-01)", tone: "ok" });
    expect(describeLastDelivery({ ...base, status: "pending" }, fmt)).toMatchObject({ tone: "warn" });
    const failed = describeLastDelivery({ ...base, status: "failed" }, fmt);
    expect(failed.tone).toBe("bad");
    expect(failed.text).toMatch(/failed \(at 2026-10-01\)\. The endpoint answered 500\./);
  });
});

describe("describeDelivery", () => {
  it("reads as a sentence and pluralises attempts", () => {
    const d = { id: "1", event: "post.failed", attempts: 1, statusCode: 200, error: null, createdAt: "x", deliveredAt: "y" };
    expect(describeDelivery({ ...d, status: "delivered" })).toBe("Delivered (200), 1 attempt");
    expect(describeDelivery({ ...d, status: "failed", attempts: 6, error: "Gave up after 6 attempts." })).toBe("Failed after 6 attempts: Gave up after 6 attempts.");
    expect(describeDelivery({ ...d, status: "pending", attempts: 2, error: "The endpoint answered 503." })).toBe("Retrying, 2 attempts: The endpoint answered 503.");
  });
});
