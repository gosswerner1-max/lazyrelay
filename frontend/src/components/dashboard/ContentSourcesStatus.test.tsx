import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ContentSourcesStatus } from "./ContentSourcesStatus";
import { deriveOverall, describeQueue, summarizeQueue } from "../../lib/contentSourcesStatus";
import type { ScheduledPost } from "../../lib/api";
import type { ContentSourcesClient } from "../../lib/contentSources";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DASH = /[\u2013\u2014]/;

const post = (over: Partial<ScheduledPost>): ScheduledPost =>
  ({ id: Math.random().toString(36), content: "x", status: "pending", paused_at: null, tags: [], social_account_id: "a", scheduled_for: "2026-10-21T08:00:00Z", ...over }) as ScheduledPost;

const PAUSED = "2026-10-20T10:00:00Z";
const clientWith = (ready?: ContentSourcesClient["ready"]): ContentSourcesClient => (ready ? { ready } : {});

function show(props: { posts?: ScheduledPost[]; client?: ContentSourcesClient }) {
  return render(<ContentSourcesStatus posts={props.posts ?? []} client={props.client ?? clientWith()} />);
}

const badge = () => screen.getByTestId("status-badge");
const region = () => screen.getByRole("region", { name: "Live status" });
const health = () => within(region()).getByTestId("service-health");

describe("summarizeQueue", () => {
  it("counts only pending posts: scheduled and paused", () => {
    const q = summarizeQueue([post({}), post({}), post({ paused_at: PAUSED }), post({ status: "posted" }), post({ status: "draft" }), post({ status: "failed" })]);
    expect(q).toEqual({ scheduled: 2, paused: 1 });
  });

  it("is empty when nothing is pending", () => {
    expect(summarizeQueue([])).toEqual({ scheduled: 0, paused: 0 });
  });
});

describe("deriveOverall (the badge comes from the data, never from a fixed word)", () => {
  const none = { scheduled: 0, paused: 0 };
  it.each([
    ["service down beats everything", { scheduled: 2, paused: 0 }, "down", "problem"],
    ["a paused queue is Paused", { scheduled: 0, paused: 2 }, "ok", "paused"],
    ["a paused queue stays Paused while the service is still being asked", { scheduled: 0, paused: 2 }, "checking", "paused"],
    ["still asking the service", { scheduled: 1, paused: 0 }, "checking", "checking"],
    ["scheduled posts and a service that answers is Running", { scheduled: 1, paused: 0 }, "ok", "running"],
    ["some paused, some scheduled, service up is Running", { scheduled: 1, paused: 3 }, "ok", "running"],
    ["a service that answers with nothing waiting is Unknown, not Running", none, "ok", "unknown"],
    ["scheduled posts but a service that cannot be told is Unknown", { scheduled: 1, paused: 0 }, "unknown", "unknown"],
    ["nothing at all is Unknown", none, "unknown", "unknown"],
  ] as const)("%s", (_name, queue, h, expected) => {
    expect(deriveOverall(queue, h)).toBe(expected);
  });
});

describe("describeQueue", () => {
  it.each([
    [{ scheduled: 0, paused: 0 }, "Nothing scheduled"],
    [{ scheduled: 0, paused: 3 }, "Posting is paused"],
    [{ scheduled: 2, paused: 0 }, "2 scheduled"],
    [{ scheduled: 2, paused: 1 }, "2 scheduled, 1 paused"],
  ])("%j -> %s", (queue, words) => {
    expect(describeQueue(queue)).toBe(words);
  });
});

describe("the status panel shows only what it can read", () => {
  it("running: a reachable service and posts waiting to go out", async () => {
    show({ posts: [post({}), post({})], client: clientWith(async () => true) });
    await waitFor(() => expect(badge()).toHaveTextContent("Running"));
    expect(region()).toHaveTextContent("2 scheduled");
    expect(health()).toHaveTextContent("OK");
  });

  it("shows paused and scheduled counts together", async () => {
    show({ posts: [post({}), post({}), post({ paused_at: PAUSED })], client: clientWith(async () => true) });
    await waitFor(() => expect(badge()).toHaveTextContent("Running"));
    expect(region()).toHaveTextContent("2 scheduled, 1 paused");
  });

  it("paused: when every pending post is paused it says 'Posting is paused'", async () => {
    show({ posts: [post({ paused_at: PAUSED }), post({ paused_at: "2026-10-20T10:05:00Z" })], client: clientWith(async () => true) });
    await waitFor(() => expect(badge()).toHaveTextContent("Paused"));
    expect(region()).toHaveTextContent("Posting is paused");
    expect(region()).not.toHaveTextContent(/\bscheduled\b/);
  });

  it("an empty queue is said plainly, is not paused, and the badge stays Unknown", async () => {
    show({ posts: [], client: clientWith(async () => true) });
    await waitFor(() => expect(health()).toHaveTextContent("OK"));
    expect(region()).toHaveTextContent("Nothing scheduled");
    expect(region()).not.toHaveTextContent("Posting is paused");
    expect(badge()).toHaveTextContent("Unknown");
  });

  it("a service check that could not be made (null) is Unknown, not Problem and not green", async () => {
    show({ posts: [post({})], client: clientWith(async () => null) });
    await waitFor(() => expect(health()).toHaveTextContent("Unknown"));
    expect(badge()).toHaveTextContent("Unknown");
  });

  it("problem: a service that does not answer makes the badge Problem and says 'Not reachable'", async () => {
    show({ posts: [post({})], client: clientWith(async () => false) });
    await waitFor(() => expect(badge()).toHaveTextContent("Problem"));
    expect(health()).toHaveTextContent("Not reachable");
  });

  it("problem wins over paused", async () => {
    show({ posts: [post({ paused_at: PAUSED })], client: clientWith(async () => false) });
    await waitFor(() => expect(badge()).toHaveTextContent("Problem"));
  });

  it("unknown: no service check at all shows Unknown everywhere and no green or 'active'", async () => {
    show({ posts: [post({})], client: clientWith() });
    await waitFor(() => expect(health()).toHaveTextContent("Unknown"));
    expect(badge()).toHaveTextContent("Unknown");
    expect(region().textContent).not.toMatch(/active|\bok\b|healthy|online|cloud/i);
    expect(badge().className).not.toMatch(/ok/);
  });

  it("unknown: a check that throws is Unknown, not Problem and not green", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    show({ client: clientWith(async () => Promise.reject(new Error("weird"))) });
    await waitFor(() => expect(health()).toHaveTextContent("Unknown"));
    expect(badge()).toHaveTextContent("Unknown");
  });

  it("gives up on a check that never answers after a few seconds, so it never sits on 'Checking'", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    show({ client: clientWith(() => new Promise<boolean>(() => undefined)) });
    expect(health()).toHaveTextContent(/checking/i);
    await act(async () => {
      vi.advanceTimersByTime(9_000);
    });
    expect(health()).toHaveTextContent("Unknown");
  });

  it("checks again when asked", async () => {
    const ready = vi.fn(async () => true);
    show({ client: clientWith(ready) });
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
  });

  it("has nothing left from the old own-site sources: no source list, no last-checked time, no engine row", async () => {
    show({ posts: [post({})], client: clientWith(async () => true) });
    await waitFor(() => expect(badge()).toHaveTextContent("Running"));
    expect(within(region()).queryByRole("listitem")).toBeNull();
    expect(region().textContent).not.toMatch(/last checked|never run|no sources|content engine|source/i);
    expect(within(region()).getAllByRole("term").map((t) => t.textContent)).toEqual(["Posting queue", "Service"]);
  });

  it("never makes a claim we cannot back up, and has no em or en dash", async () => {
    show({ posts: [post({})], client: clientWith(async () => true) });
    await waitFor(() => expect(badge()).toHaveTextContent("Running"));
    const text = region().textContent ?? "";
    expect(text).not.toMatch(DASH);
    expect(text).not.toMatch(/uptime|availability|99|offload|vault|computer|always|24\/7|guarantee|instant|safe|accurate/i);
  });
});
