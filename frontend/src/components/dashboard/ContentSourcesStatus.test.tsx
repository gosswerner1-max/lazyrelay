import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ContentSourcesStatus } from "./ContentSourcesStatus";
import { describeLastChecked, summarizeQueue } from "../../lib/contentSourcesStatus";
import type { ScheduledPost } from "../../lib/api";
import type { ContentSourcesClient, ServiceSource } from "../../lib/contentSources";
import { createMockContentSourcesClient } from "../../lib/contentSourcesMock";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NOW = Date.parse("2026-10-20T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const DASH = /[\u2013\u2014]/;

const post = (over: Partial<ScheduledPost>): ScheduledPost =>
  ({ id: Math.random().toString(36), content: "x", status: "pending", paused_at: null, tags: [], social_account_id: "a", scheduled_for: "2026-10-21T08:00:00Z", ...over }) as ScheduledPost;

const source = (over: Partial<ServiceSource> = {}): ServiceSource => ({
  id: "s1",
  sourceType: "rss",
  sourceUrl: "https://example.com/feed.xml",
  syncInterval: "daily",
  brandId: null,
  lastSyncedAt: null,
  domainVerified: true,
  verificationMethod: "well_known",
  lastError: null,
  consecutiveFailures: 0,
  verificationToken: null,
  ...over,
});

const clientWith = (ready?: ContentSourcesClient["ready"]): ContentSourcesClient => {
  const base = createMockContentSourcesClient();
  if (ready) base.ready = ready;
  return base;
};

function show(props: { posts?: ScheduledPost[]; sources?: ServiceSource[] | null; client?: ContentSourcesClient }) {
  return render(<ContentSourcesStatus posts={props.posts ?? []} sources={props.sources === undefined ? [] : props.sources} client={props.client ?? clientWith()} now={() => NOW} />);
}

const badge = () => screen.getByTestId("status-badge");
const region = () => screen.getByRole("region", { name: "Live status" });

describe("summarizeQueue", () => {
  it("counts only pending posts: scheduled and paused", () => {
    const q = summarizeQueue([post({}), post({}), post({ paused_at: "2026-10-20T10:00:00Z" }), post({ status: "posted" }), post({ status: "draft" }), post({ status: "failed" })]);
    expect(q).toEqual({ scheduled: 2, paused: 1 });
  });

  it("is empty when nothing is pending", () => {
    expect(summarizeQueue([])).toEqual({ scheduled: 0, paused: 0 });
  });
});

describe("describeLastChecked", () => {
  it.each([
    [null, "Never run"],
    ["not a date", "Unknown"],
    [minutesAgo(0.2), "Last checked less than a minute ago"],
    [minutesAgo(1), "Last checked 1 minute ago"],
    [minutesAgo(12), "Last checked 12 minutes ago"],
    [minutesAgo(60), "Last checked 1 hour ago"],
    [minutesAgo(3 * 60 + 5), "Last checked 3 hours ago"],
    [minutesAgo(24 * 60), "Last checked 1 day ago"],
    [minutesAgo(5 * 24 * 60), "Last checked 5 days ago"],
    [new Date(NOW + 30 * 60_000).toISOString(), "Last checked less than a minute ago"],
  ])("%s -> %s", (iso, words) => {
    expect(describeLastChecked(iso, NOW)).toBe(words);
  });
});

describe("the status panel shows only what it can read", () => {
  it("running: a reachable service, scheduled posts and a recent check", async () => {
    show({
      posts: [post({}), post({})],
      sources: [source({ lastSyncedAt: minutesAgo(12) })],
      client: clientWith(async () => true),
    });
    await waitFor(() => expect(badge()).toHaveTextContent("Running"));
    expect(region()).toHaveTextContent("2 scheduled");
    expect(region()).toHaveTextContent("Last checked 12 minutes ago");
    expect(within(region()).getByTestId("service-health")).toHaveTextContent("OK");
  });

  it("shows paused and scheduled counts together", async () => {
    show({ posts: [post({}), post({}), post({ paused_at: "2026-10-20T10:00:00Z" })], client: clientWith(async () => true) });
    await waitFor(() => expect(badge()).toHaveTextContent("Running"));
    expect(region()).toHaveTextContent("2 scheduled, 1 paused");
  });

  it("paused: when every pending post is paused it says 'Posting is paused'", async () => {
    show({ posts: [post({ paused_at: "2026-10-20T10:00:00Z" }), post({ paused_at: "2026-10-20T10:05:00Z" })], client: clientWith(async () => true) });
    await waitFor(() => expect(badge()).toHaveTextContent("Paused"));
    expect(region()).toHaveTextContent("Posting is paused");
    expect(region()).not.toHaveTextContent(/\bscheduled\b/);
  });

  it("an empty queue is said plainly and is not paused", async () => {
    show({ posts: [], client: clientWith(async () => true) });
    await waitFor(() => expect(badge()).toHaveTextContent("Running"));
    expect(region()).toHaveTextContent("Nothing scheduled");
    expect(region()).not.toHaveTextContent("Posting is paused");
  });

  it("error: a source with a problem makes the badge Problem and says what it was in plain words", async () => {
    show({ posts: [post({})], sources: [source({ lastError: "fetch:timeout", consecutiveFailures: 2, lastSyncedAt: minutesAgo(30) })], client: clientWith(async () => true) });
    await waitFor(() => expect(badge()).toHaveTextContent("Problem"));
    expect(region()).toHaveTextContent("We could not open the address");
    expect(region().textContent).not.toContain("fetch:timeout");
  });

  it("error: a service that does not answer makes the badge Problem and says 'Not reachable'", async () => {
    show({ posts: [post({})], client: clientWith(async () => false) });
    await waitFor(() => expect(badge()).toHaveTextContent("Problem"));
    expect(within(region()).getByTestId("service-health")).toHaveTextContent("Not reachable");
  });

  it("problem wins over paused", async () => {
    show({ posts: [post({ paused_at: "2026-10-20T10:00:00Z" })], client: clientWith(async () => false) });
    await waitFor(() => expect(badge()).toHaveTextContent("Problem"));
  });

  it("unknown: a service check that cannot be made, and sources that were not read, show Unknown everywhere and no green", async () => {
    show({ posts: [post({})], sources: null, client: clientWith() });
    await waitFor(() => expect(within(region()).getByTestId("service-health")).toHaveTextContent("Unknown"));
    expect(badge()).toHaveTextContent("Unknown");
    expect(within(region()).getByTestId("engine-unknown")).toHaveTextContent("Unknown");
    expect(region().textContent).not.toMatch(/active|\bok\b|healthy|online/i);
    expect(badge().className).not.toMatch(/ok/);
  });

  it("unknown: a check that throws is Unknown, not Problem and not green", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    show({ client: clientWith(async () => Promise.reject(new Error("weird"))) });
    await waitFor(() => expect(within(region()).getByTestId("service-health")).toHaveTextContent("Unknown"));
    expect(badge()).toHaveTextContent("Unknown");
  });

  it("gives up on a check that never answers after a few seconds, so it never sits on 'Checking'", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    show({ client: clientWith(() => new Promise<boolean>(() => undefined)) });
    expect(within(region()).getByTestId("service-health")).toHaveTextContent(/checking/i);
    await act(async () => {
      vi.advanceTimersByTime(9_000);
    });
    expect(within(region()).getByTestId("service-health")).toHaveTextContent("Unknown");
  });

  it("lists each source with its last check, and 'Never run' for one that has not run", async () => {
    show({
      sources: [source({ id: "a", lastSyncedAt: minutesAgo(5) }), source({ id: "b", sourceType: "sitemap", sourceUrl: "https://shop.example/sitemap.xml", lastSyncedAt: null })],
      client: clientWith(async () => true),
    });
    await waitFor(() => expect(badge()).toHaveTextContent("Running"));
    const rows = within(region()).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("example.com");
    expect(rows[0]).toHaveTextContent("Last checked 5 minutes ago");
    expect(rows[1]).toHaveTextContent("shop.example");
    expect(rows[1]).toHaveTextContent("Never run");
  });

  it("says there are no sources yet when the list is empty", async () => {
    show({ sources: [], client: clientWith(async () => true) });
    expect(await screen.findByText(/no sources yet/i)).toBeInTheDocument();
  });

  it("says that background checks only happen while the engine is running", () => {
    show({});
    expect(region()).toHaveTextContent("Background checks only happen while the engine is running.");
  });

  it("checks again when asked", async () => {
    const ready = vi.fn(async () => true);
    show({ client: clientWith(ready) });
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
  });

  it("never makes a claim we cannot back up, and has no em or en dash", async () => {
    show({ posts: [post({})], sources: [source({ lastSyncedAt: minutesAgo(3) })], client: clientWith(async () => true) });
    await waitFor(() => expect(badge()).toHaveTextContent("Running"));
    const text = region().textContent ?? "";
    expect(text).not.toMatch(DASH);
    expect(text).not.toMatch(/uptime|availability|99|offload|vault|computer|always|24\/7|guarantee|instant|safe|accurate/i);
  });
});
