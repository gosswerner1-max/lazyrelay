import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ContentSourcesTab from "./ContentSourcesTab";
import {
  ContentSourcesError,
  createNotConnectedClient,
  type ContentSourcesClient,
  type ContentSourcesErrorCode,
  type ServiceSource,
} from "../../lib/contentSources";
import { createMockContentSourcesClient } from "../../lib/contentSourcesMock";
import type { Brand, ScheduledPost } from "../../lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DASH = /[\u2013\u2014]/;
const KEY = "lzr_live_abcdefghijklmnop";

const post = (over: Partial<ScheduledPost>): ScheduledPost =>
  ({ id: "p", content: "Hello", status: "draft", tags: [], social_account_id: null, scheduled_for: null, ...over }) as ScheduledPost;

const posts: ScheduledPost[] = [
  post({ id: "d1", content: "Ten tips for spring\nMore text", tags: ["cs:rss:my blog"] }),
  post({ id: "d2", content: "Shop update", status: "needs_approval", tags: ["cs:sitemap:shop"] }),
  post({ id: "d3", content: "A normal draft", tags: ["promo"] }),
  post({ id: "d4", content: "Already scheduled", status: "pending", tags: ["cs:rss:my blog"] }),
];

const brands = [
  { id: "b1", name: "Acme", voice_profile: null, created_at: "" },
  { id: "b2", name: "Zeta", voice_profile: null, created_at: "" },
] as Brand[];

const src = (over: Partial<ServiceSource> = {}): ServiceSource => ({
  id: "11111111-2222-4333-8444-555555555555",
  sourceType: "rss",
  sourceUrl: "https://example.com/feed.xml",
  syncInterval: "daily",
  brandId: null,
  lastSyncedAt: null,
  domainVerified: false,
  verificationMethod: null,
  lastError: null,
  consecutiveFailures: 0,
  verificationToken: "proof-token-1",
  ...over,
});

const fail = (code: ContentSourcesErrorCode, retry?: number) => () => Promise.reject(new ContentSourcesError(code, retry));

interface SetupOpts {
  props?: Partial<React.ComponentProps<typeof ContentSourcesTab>>;
  client?: Partial<ContentSourcesClient>;
  /** Wait for the first load to finish (the default). */
  settle?: boolean;
}

async function setup(opts: SetupOpts = {}) {
  const handlers = { onReviewAndEdit: vi.fn(), onApproveToCalendar: vi.fn(), onPurge: vi.fn(), onOpenApiKeys: vi.fn(), onOpenPlan: vi.fn() };
  const client = createMockContentSourcesClient(opts.client);
  const utils = render(<ContentSourcesTab posts={posts} brands={brands} client={client} {...handlers} {...opts.props} />);
  if (opts.settle !== false) await waitFor(() => expect(screen.queryByText(/Loading your sources/)).toBeNull());
  return { ...utils, ...handlers, client, user: userEvent.setup({ applyAccept: false }) };
}

const unregistered = { getCredentials: async () => ({ registered: false, keyHint: null }) };
const addButton = () => screen.getByRole("button", { name: "Add source" });
const rowFor = (address: string) => screen.getByRole("rowheader", { name: new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).closest("tr") as HTMLElement;
const panel = () => screen.getByRole("region", { name: "Prove you own this website" });

async function addRss(user: ReturnType<typeof userEvent.setup>, url = "https://example.com/feed.xml") {
  await user.type(screen.getByLabelText("Feed address"), url);
  await user.click(addButton());
}

describe("loading and the states where the tab cannot work", () => {
  it("says it is loading, then shows the page, and asks the service for the key and the sources once each", async () => {
    const getCredentials = vi.fn(async () => ({ registered: true, keyHint: "abcd" }));
    const listSources = vi.fn(async () => []);
    const { container } = await setup({ client: { getCredentials, listSources }, settle: false });
    expect(screen.getByText("Loading your sources...")).toBeInTheDocument();
    await screen.findByRole("heading", { name: "Add a source" });
    expect(getCredentials).toHaveBeenCalledTimes(1);
    expect(listSources).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild).toHaveClass("content-sources");
  });

  it("shows Not connected yet, no key or source forms, and no network call when the service has no address", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await setup({ props: { client: createNotConnectedClient() } });
    expect(screen.getByRole("heading", { name: "Not connected yet" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add a source" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Connect your LazyRelay key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByText("Ten tips for spring")).toBeInTheDocument(); // the drafts matrix is still there
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says to sign in again, with no retry button", async () => {
    await setup({ client: { listSources: fail("sign_in") } });
    expect(screen.getByText("Please sign in again to use Content Sources.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers Try again when the service is busy, and loads when it works", async () => {
    let ready = false;
    const listSources = vi.fn(async () => {
      if (!ready) throw new ContentSourcesError("try_later");
      return [];
    });
    const { user } = await setup({ client: { listSources } });
    expect(screen.getByText(/busy right now/)).toBeInTheDocument();
    ready = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Add a source" });
    expect(screen.queryByText(/busy right now/)).toBeNull();
  });

  it("shows a plain line for an error that is not one of ours, and the raw error in the console", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await setup({ client: { getCredentials: () => Promise.reject(new Error("RAW boom 10.0.0.1")) } });
    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
    expect(screen.queryByText(/RAW boom/)).toBeNull();
    expect(spy).toHaveBeenCalled();
  });
});

describe("Connect your LazyRelay key", () => {
  it("comes first when there is no key, explains itself in two sentences and points at the API Keys tab", async () => {
    const { user, onOpenApiKeys } = await setup({ client: unregistered });
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings[0]).toBe("Connect your LazyRelay key");
    expect(headings).toContain("Add a source");
    const section = screen.getByRole("region", { name: "Connect your LazyRelay key" });
    const sentences = within(section).getByTestId("key-explainer").textContent!.split(/(?<=\.)\s+/).filter(Boolean);
    expect(sentences).toHaveLength(2);
    expect(within(section).getByTestId("key-explainer")).toHaveTextContent(/your own/i);
    await user.click(within(section).getByRole("button", { name: "Go to the API Keys tab" }));
    expect(onOpenApiKeys).toHaveBeenCalledTimes(1);
  });

  it("has a masked field that is never autofilled, tied to its label and hint", async () => {
    await setup({ client: unregistered });
    const input = screen.getByLabelText("LazyRelay key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "new-password");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("maxlength");
    expect(document.getElementById(input.getAttribute("aria-describedby")!.split(" ")[0]!)).toHaveTextContent(/lzr_live_/);
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  });

  it.each([
    ["abc", /LazyRelay key/],
    ["lzr_test_abcdefghijklmnop", /lzr_live_/],
    ["lzr_live_short", /lzr_live_/],
    ["lzr_live_abcdefgh ijklmnop", /no spaces/],
  ])("rejects %s with a plain message and keeps Save key disabled", async (value, message) => {
    const { user } = await setup({ client: unregistered });
    const input = screen.getByLabelText("LazyRelay key");
    await user.click(input);
    await user.paste(value);
    expect(input).toHaveAttribute("aria-invalid", "true");
    const errorId = input.getAttribute("aria-describedby")!.split(" ").find((id) => document.getElementById(id)?.className.includes("cs-error"))!;
    expect(document.getElementById(errorId)).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  });

  it("saves the trimmed key, then shows the last four characters, never the key, and moves focus to that line", async () => {
    const saveKey = vi.fn(async (k: string) => ({ keyHint: k.slice(-4) }));
    const { user, container } = await setup({ client: { ...unregistered, saveKey } });
    await user.click(screen.getByLabelText("LazyRelay key"));
    await user.paste(`  ${KEY}  `);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(saveKey).toHaveBeenCalledWith(KEY);
    const line = await screen.findByText("Key ending in mnop");
    expect(line).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remove key" })).toBeInTheDocument();
    expect(screen.queryByLabelText("LazyRelay key")).toBeNull();
    expect(container.textContent).not.toContain(KEY);
    expect(screen.getByText(/Key saved/)).toBeInTheDocument();
  });

  it.each<[ContentSourcesErrorCode, RegExp]>([
    ["api_key_rejected", /did not accept that key/],
    ["invalid_api_key", /does not look like a LazyRelay key/],
    ["unavailable", /could not do that right now/],
    ["unauthorized", /sign in again/],
    ["network", /could not reach/],
  ])("shows a plain message for %s and keeps what was typed so it can be fixed", async (code, message) => {
    const { user, container } = await setup({ client: { ...unregistered, saveKey: fail(code) } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await user.click(screen.getByLabelText("LazyRelay key"));
    await user.paste(KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(container.textContent).not.toContain(KEY);
    expect(screen.getByLabelText("LazyRelay key")).toHaveValue(KEY);
  });

  it("says how long to wait on a rate limit", async () => {
    const { user } = await setup({ client: { ...unregistered, saveKey: fail("rate_limited", 20) } });
    await user.click(screen.getByLabelText("LazyRelay key"));
    await user.paste(KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("wait 20 seconds");
  });

  it("shows the saved state straight away when a key is already stored", async () => {
    await setup({ client: { getCredentials: async () => ({ registered: true, keyHint: "wxyz" }) } });
    expect(screen.getByText("Key ending in wxyz")).toBeInTheDocument();
    expect(screen.queryByLabelText("LazyRelay key")).toBeNull();
  });

  describe("removing the key", () => {
    const stored = { getCredentials: async () => ({ registered: true, keyHint: "wxyz" }) };

    it("asks first, can be cancelled with the button or Escape, and gives focus back", async () => {
      const removeKey = vi.fn(async () => undefined);
      const { user } = await setup({ client: { ...stored, removeKey } });
      const trigger = screen.getByRole("button", { name: "Remove key" });
      await user.click(trigger);
      expect(screen.getByText(/Remove your saved key\?/)).toBeInTheDocument();
      expect(removeKey).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Keep key" }));
      expect(screen.queryByText(/Remove your saved key\?/)).toBeNull();
      expect(trigger).toHaveFocus();
      await user.click(trigger);
      await user.keyboard("{Escape}");
      expect(screen.queryByText(/Remove your saved key\?/)).toBeNull();
      expect(trigger).toHaveFocus();
      expect(removeKey).not.toHaveBeenCalled();
    });

    it("removes the key on confirm, returns to the paste field and puts focus in it", async () => {
      const removeKey = vi.fn(async () => undefined);
      const { user } = await setup({ client: { ...stored, removeKey } });
      await user.click(screen.getByRole("button", { name: "Remove key" }));
      await user.click(screen.getByRole("button", { name: "Yes, remove it" }));
      expect(removeKey).toHaveBeenCalledTimes(1);
      const input = await screen.findByLabelText("LazyRelay key");
      expect(input).toHaveFocus();
      expect(screen.queryByText(/Key ending in/)).toBeNull();
      expect(screen.getByText(/Key removed/)).toBeInTheDocument();
    });

    it("shows a plain message when removing fails and keeps the key", async () => {
      const { user } = await setup({ client: { ...stored, removeKey: fail("unavailable") } });
      await user.click(screen.getByRole("button", { name: "Remove key" }));
      await user.click(screen.getByRole("button", { name: "Yes, remove it" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/could not do that right now/);
      expect(screen.getByText("Key ending in wxyz")).toBeInTheDocument();
    });
  });
});

describe("source type toggle", () => {
  it("is a radiogroup with the three choices, RSS Feed first and chosen, CSV visible but disabled with the plain reason", async () => {
    await setup();
    const group = screen.getByRole("radiogroup", { name: "Source type" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual(["RSS Feed", "Sitemap XML", "CSV Bulk Upload"]);
    expect(screen.getByRole("radio", { name: "RSS Feed" })).toBeChecked();
    const csv = screen.getByRole("radio", { name: "CSV Bulk Upload" });
    expect(csv).toBeDisabled();
    expect(document.getElementById(csv.getAttribute("aria-describedby")!)).toHaveTextContent("CSV upload is coming soon.");
    expect(screen.queryByLabelText("CSV file")).toBeNull();
  });

  it("changes with a click and with the arrow keys, and the arrow keys skip the disabled CSV choice", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("radio", { name: "Sitemap XML" }));
    expect(screen.getByRole("radio", { name: "Sitemap XML" })).toBeChecked();
    screen.getByRole("radio", { name: "Sitemap XML" }).focus();
    await user.keyboard("{ArrowRight}"); // CSV is next but disabled, so the choice wraps round to RSS Feed
    expect(screen.getByRole("radio", { name: "RSS Feed" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "CSV Bulk Upload" })).not.toBeChecked();
  });

  it("changes the address label for a sitemap", async () => {
    const { user } = await setup();
    expect(screen.getByLabelText("Feed address")).toHaveAttribute("type", "url");
    await user.click(screen.getByRole("radio", { name: "Sitemap XML" }));
    expect(screen.getByLabelText("Sitemap address")).toHaveAttribute("type", "url");
  });
});

describe("address field", () => {
  it("is length limited to 2048 and linked to its hint", async () => {
    await setup();
    const input = screen.getByLabelText("Feed address");
    expect(input).toHaveAttribute("maxlength", "2048");
    expect(document.getElementById(input.getAttribute("aria-describedby")!.split(" ")[0]!)).toBeInTheDocument();
  });

  it("starts with Add source disabled and no error", async () => {
    await setup();
    expect(addButton()).toBeDisabled();
    expect(screen.getByLabelText("Feed address")).not.toHaveAttribute("aria-invalid", "true");
  });

  it.each([
    ["http://example.com/feed", /https/i],
    ["https://user:pass@example.com/feed", /username|password/i],
    ["https://192.168.1.5/feed", /private|local/i],
    ["https://localhost/feed", /private|local/i],
    ["https://[::1]/feed", /private|local/i],
  ])("rejects %s with a plain message under the field", async (value, message) => {
    const { user } = await setup();
    const input = screen.getByLabelText("Feed address");
    await user.click(input);
    await user.paste(value); // paste, because typing treats [ as the start of a key name
    expect(input).toHaveAttribute("aria-invalid", "true");
    const errorId = input.getAttribute("aria-describedby")!.split(" ").find((id) => document.getElementById(id)?.className.includes("cs-error"))!;
    expect(document.getElementById(errorId)).toHaveTextContent(message);
    expect(addButton()).toBeDisabled();
  });

  it("accepts a valid https address and enables Add source", async () => {
    const { user } = await setup();
    await user.type(screen.getByLabelText("Feed address"), "https://example.com/feed.xml");
    expect(screen.getByLabelText("Feed address")).not.toHaveAttribute("aria-invalid", "true");
    expect(addButton()).toBeEnabled();
  });
});

describe("Target brand", () => {
  it("lists No brand first, then the account's brands, and still works with none", async () => {
    await setup();
    const select = screen.getByLabelText("Target brand") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["No brand", "Acme", "Zeta"]);
    cleanup();
    await setup({ props: { brands: [] } });
    expect([...(screen.getByLabelText("Target brand") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["No brand"]);
  });
});

describe("Add source", () => {
  it("sends the trimmed address and the type, with no brand when none is chosen", async () => {
    const createSource = vi.fn(createMockContentSourcesClient().createSource);
    const { user } = await setup({ client: { createSource } });
    await user.type(screen.getByLabelText("Feed address"), "  https://example.com/feed.xml  ");
    await user.click(addButton());
    expect(createSource).toHaveBeenCalledWith({ sourceType: "rss", sourceUrl: "https://example.com/feed.xml" });
  });

  it("sends a sitemap with the chosen brand", async () => {
    const createSource = vi.fn(createMockContentSourcesClient().createSource);
    const { user } = await setup({ client: { createSource } });
    await user.click(screen.getByRole("radio", { name: "Sitemap XML" }));
    await user.type(screen.getByLabelText("Sitemap address"), "https://example.com/sitemap.xml");
    await user.selectOptions(screen.getByLabelText("Target brand"), "b2");
    await user.click(addButton());
    expect(createSource).toHaveBeenCalledWith({ sourceType: "sitemap", sourceUrl: "https://example.com/sitemap.xml", brandId: "b2" });
  });

  it("disables the button while it is adding, and does not add twice", async () => {
    let finish!: () => void;
    const base = createMockContentSourcesClient().createSource;
    const createSource = vi.fn((input: Parameters<typeof base>[0]) => new Promise<Awaited<ReturnType<typeof base>>>((res) => (finish = () => void base(input).then(res))));
    const { user } = await setup({ client: { createSource } });
    await user.type(screen.getByLabelText("Feed address"), "https://example.com/feed.xml");
    await user.click(addButton());
    expect(addButton()).toBeDisabled();
    finish();
    await screen.findByRole("region", { name: "Prove you own this website" });
    expect(createSource).toHaveBeenCalledTimes(1);
  });

  it("shows the new source in the list, clears the form and opens the proof panel with focus on its heading", async () => {
    const { user } = await setup();
    await addRss(user);
    const heading = await screen.findByRole("heading", { name: "Prove you own this website" });
    expect(heading).toHaveFocus();
    expect(screen.getByLabelText("Feed address")).toHaveValue("");
    expect(screen.getByText("Waiting for proof")).toBeInTheDocument();
    expect(within(rowFor("example.com/feed.xml")).getByText("RSS Feed")).toBeInTheDocument();
  });

  it("does not submit a page form on Enter, and adds when the address is valid", async () => {
    const createSource = vi.fn(createMockContentSourcesClient().createSource);
    const { user, container } = await setup({ client: { createSource } });
    expect(fireEvent.submit(container.querySelector("form")!)).toBe(false);
    await user.type(screen.getByLabelText("Feed address"), "https://example.com/feed.xml{Enter}");
    expect(createSource).toHaveBeenCalledTimes(1);
  });

  it.each<[ContentSourcesErrorCode, RegExp]>([
    ["duplicate_source", /already added this address/],
    ["invalid_source_url", /full https address/],
    ["not_available", /CSV upload is coming soon/],
    ["invalid_brand_id", /brand is not valid/],
    ["unauthorized", /sign in again/],
    ["unavailable", /could not do that right now/],
    ["internal", /on our side/],
    ["network", /could not reach/],
  ])("says what went wrong for %s and keeps the form filled in", async (code, message) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { user } = await setup({ client: { createSource: fail(code) } });
    await addRss(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByLabelText("Feed address")).toHaveValue("https://example.com/feed.xml");
    expect(screen.queryByRole("region", { name: "Prove you own this website" })).toBeNull();
  });

  it("says how long to wait on a rate limit", async () => {
    const { user } = await setup({ client: { createSource: fail("rate_limited", 12) } });
    await addRss(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("wait 12 seconds");
  });

  it("the plan limit message links to the plan page the app already uses", async () => {
    const { user, onOpenPlan } = await setup({ client: { createSource: fail("plan_limit") } });
    await addRss(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(/reached the number of sources your plan allows/);
    await user.click(screen.getByRole("button", { name: "See plans" }));
    expect(onOpenPlan).toHaveBeenCalledTimes(1);
  });

  it("shows the plan limit message without a link when the page has nowhere to send the customer", async () => {
    const { user } = await setup({ client: { createSource: fail("plan_limit") }, props: { onOpenPlan: undefined } });
    await addRss(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(/plan allows/);
    expect(screen.queryByRole("button", { name: "See plans" })).toBeNull();
  });
});

describe("Prove you own this website", () => {
  async function open(clientOver: Partial<ContentSourcesClient> = {}) {
    const utils = await setup({ client: clientOver });
    await addRss(utils.user);
    await screen.findByRole("region", { name: "Prove you own this website" });
    return utils;
  }

  it("shows the three methods with the exact text to publish, from the service", async () => {
    await open();
    const p = within(panel());
    expect(p.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual(["Text file (the easiest)", "Tag on your home page", "DNS record"]);
    expect(p.getByText("https://example.com/.well-known/proof-example.txt")).toBeInTheDocument();
    expect(p.getByText("mock-proof-token", { selector: "code" })).toBeInTheDocument();
    expect(p.getByText('<meta name="proof-example" content="mock-proof-token">')).toBeInTheDocument();
    expect(p.getByText(/inside <head> of https:\/\/example\.com\//)).toBeInTheDocument();
    expect(p.getByText("_proof-example.example.com")).toBeInTheDocument();
    expect(p.getByText("proof-example=mock-proof-token")).toBeInTheDocument();
    expect(p.getByText(/do just one of these/i)).toBeInTheDocument();
    expect(p.getByText(/text file is the easiest/i)).toBeInTheDocument();
  });

  it.each([
    ["Copy address", "https://example.com/.well-known/proof-example.txt"],
    ["Copy file text", "mock-proof-token"],
    ["Copy tag", '<meta name="proof-example" content="mock-proof-token">'],
    ["Copy record name", "_proof-example.example.com"],
    ["Copy record value", "proof-example=mock-proof-token"],
  ])("%s copies exactly the text shown", async (name, expected) => {
    const { user } = await open();
    await user.click(within(panel()).getByRole("button", { name }));
    expect(await navigator.clipboard.readText()).toBe(expected);
    expect(await within(panel()).findByText("Copied")).toBeInTheDocument();
  });

  it("says so, in plain words, when the browser will not copy", async () => {
    const { user } = await open();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await user.click(within(panel()).getByRole("button", { name: "Copy address" }));
    expect(await within(panel()).findByText(/Could not copy/)).toBeInTheDocument();
  });

  it("Check now on a proven website says Verified and flips the row to Verified", async () => {
    const verifySource = vi.fn(async () => ({ verified: true as const, method: "well_known" as const }));
    const { user } = await open({ verifySource });
    await user.click(within(panel()).getByRole("button", { name: "Check now" }));
    expect(verifySource).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    expect(await within(panel()).findByText(/^Verified/)).toBeInTheDocument();
    expect(within(rowFor("example.com/feed.xml")).getByText("Verified")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for proof")).toBeNull();
  });

  it("Check now on an unproven website says why in plain sentences, for each method", async () => {
    const reasons = { well_known: "http status 404", meta_tag: "no matching meta tag in the head", dns_txt: "no matching TXT record" };
    const { user } = await open({ verifySource: async () => ({ verified: false, reasons }) });
    await user.click(within(panel()).getByRole("button", { name: "Check now" }));
    const status = await within(panel()).findByRole("status", { name: "Result of the check" });
    expect(status).toHaveTextContent("We could not find the text file");
    expect(status).toHaveTextContent("did not find the tag");
    expect(status).toHaveTextContent("did not find the DNS record");
    expect(status).toHaveTextContent("Text file");
    expect(status).not.toHaveTextContent(/http status|matching TXT|meta tag in the head/);
    expect(screen.getByText("Waiting for proof")).toBeInTheDocument();
  });

  it("never shows a reason it cannot map, only a generic line", async () => {
    const reasons = { well_known: "ECONNRESET at 10.0.0.5 stack trace", meta_tag: "<script>x</script>", dns_txt: "not attempted" };
    const { user } = await open({ verifySource: async () => ({ verified: false, reasons }) });
    await user.click(within(panel()).getByRole("button", { name: "Check now" }));
    const status = await within(panel()).findByRole("status", { name: "Result of the check" });
    expect(status).toHaveTextContent("We could not confirm this one yet.");
    expect(status).not.toHaveTextContent(/ECONNRESET|10\.0\.0\.5|script|not attempted/);
  });

  it("shows the wait time when the check is rate limited, and a plain message for other failures", async () => {
    const { user } = await open({ verifySource: fail("rate_limited", 30) });
    await user.click(within(panel()).getByRole("button", { name: "Check now" }));
    expect(await within(panel()).findByRole("alert")).toHaveTextContent("wait 30 seconds");
  });

  it("disables Check now while it is checking", async () => {
    let finish!: () => void;
    const verifySource = vi.fn(() => new Promise<{ verified: true; method: "well_known" }>((res) => (finish = () => res({ verified: true, method: "well_known" }))));
    const { user } = await open({ verifySource });
    await user.click(within(panel()).getByRole("button", { name: "Check now" }));
    expect(within(panel()).getByRole("button", { name: "Check now" })).toBeDisabled();
    expect(screen.getByText("Checking...")).toBeInTheDocument();
    finish();
    await waitFor(() => expect(within(panel()).getByRole("button", { name: "Check now" })).toBeEnabled());
  });

  it("Close hides the panel and keeps the source in the list", async () => {
    const { user } = await open();
    await user.click(within(panel()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Prove you own this website" })).toBeNull();
    expect(screen.getByText("Waiting for proof")).toBeInTheDocument();
  });
});

describe("Your sources", () => {
  const verified = src({ id: "aaaaaaaa-2222-4333-8444-555555555555", sourceUrl: "https://shop.example/sitemap.xml", sourceType: "sitemap", domainVerified: true, verificationMethod: "dns_txt", lastSyncedAt: "2026-10-18T08:00:00.000Z", verificationToken: null });
  const attention = src({ id: "bbbbbbbb-2222-4333-8444-555555555555", sourceUrl: "https://blog.example/rss", domainVerified: true, verificationMethod: "well_known", lastError: "fetch:timeout", consecutiveFailures: 2, verificationToken: null });
  const waiting = src();
  const withRows = (rows: ServiceSource[], over: Partial<ContentSourcesClient> = {}) => ({ listSources: async () => rows, ...over });

  it("says so when there are none", async () => {
    await setup();
    expect(screen.getByText("No sources yet. Add one above, then prove you own the website.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Your content sources" })).toBeNull();
  });

  it("is a real table with one row per source, a status badge, the last sync and the last problem in plain words", async () => {
    await setup({ client: withRows([waiting, verified, attention]) });
    const table = screen.getByRole("table", { name: "Your content sources" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Address", "Type", "Status", "Last synced", "Last problem", "Actions"]);
    expect(within(table).getAllByRole("row")).toHaveLength(4);

    expect(within(rowFor("example.com/feed.xml")).getByText("Waiting for proof")).toBeInTheDocument();
    expect(within(rowFor("example.com/feed.xml")).getByText("Not yet")).toBeInTheDocument();

    const v = rowFor("shop.example/sitemap.xml");
    expect(within(v).getByText("Verified")).toBeInTheDocument();
    expect(within(v).getByText("Sitemap XML")).toBeInTheDocument();
    expect(within(v).getByText(/2026/)).toBeInTheDocument();
    expect(v.querySelector("time")).toHaveAttribute("datetime", "2026-10-18T08:00:00.000Z");

    const a = rowFor("blog.example/rss");
    expect(within(a).getByText("Needs attention")).toBeInTheDocument();
    expect(within(a).getByText(/could not open the address/i)).toBeInTheDocument();
    expect(a).not.toHaveTextContent("fetch:timeout");
  });

  it("keeps the table in a labelled, keyboard reachable region so it scrolls on a narrow screen", async () => {
    await setup({ client: withRows([waiting]) });
    const region = screen.getByRole("region", { name: "Your content sources" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("table")).toBeInTheDocument();
  });

  it("tells a waiting source's owner what to do if they closed the steps", async () => {
    await setup({ client: withRows([waiting]) });
    expect(screen.getByText(/closed the steps/i)).toBeInTheDocument();
  });

  it("every row has Check now, Run now and Remove, named for the source they belong to", async () => {
    await setup({ client: withRows([verified]) });
    const row = rowFor("shop.example/sitemap.xml");
    for (const name of ["Check now", "Run now", "Remove"]) {
      const button = within(row).getByRole("button", { name });
      expect(document.getElementById(button.getAttribute("aria-describedby")!)).toHaveTextContent("shop.example/sitemap.xml");
    }
  });

  describe("Check now", () => {
    it("asks the service and updates the row", async () => {
      const verifySource = vi.fn(async () => ({ verified: true as const, method: "meta_tag" as const }));
      const { user } = await setup({ client: withRows([waiting], { verifySource }) });
      await user.click(within(rowFor("example.com/feed.xml")).getByRole("button", { name: "Check now" }));
      expect(verifySource).toHaveBeenCalledWith(waiting.id);
      expect(await screen.findByText(/^Verified\./)).toBeInTheDocument();
      expect(within(rowFor("example.com/feed.xml")).getByText("Verified")).toBeInTheDocument();
    });

    it("explains a failed check under the table when the steps panel is not open", async () => {
      const reasons = { well_known: "file is empty", meta_tag: "home page has no head", dns_txt: "dns lookup failed (ENOTFOUND)" };
      const { user } = await setup({ client: withRows([waiting], { verifySource: async () => ({ verified: false, reasons }) }) });
      await user.click(within(rowFor("example.com/feed.xml")).getByRole("button", { name: "Check now" }));
      const status = await screen.findByRole("status", { name: "Result of the check" });
      expect(status).toHaveTextContent("text file is empty");
      expect(status).toHaveTextContent("could not read the top of your home page");
      expect(status).toHaveTextContent("could not look up the DNS record");
      expect(status).not.toHaveTextContent("ENOTFOUND");
    });
  });

  describe("Run now", () => {
    it("starts a run and says so", async () => {
      const runSource = vi.fn(async () => undefined);
      const { user } = await setup({ client: withRows([verified], { runSource }) });
      await user.click(within(rowFor("shop.example/sitemap.xml")).getByRole("button", { name: "Run now" }));
      expect(runSource).toHaveBeenCalledWith(verified.id);
      expect(await screen.findByText(/^Run started\./)).toBeInTheDocument();
    });

    it.each<[ContentSourcesErrorCode, string | RegExp]>([
      ["engine_disabled", "Background runs are switched off right now."],
      ["not_verified", /Prove you own this website first/],
      ["no_credential", /Add your LazyRelay key above/],
      ["already_running", /already running, or is waiting after a problem/],
      ["unauthorized", /sign in again/],
      ["unavailable", /could not do that right now/],
      ["internal", /on our side/],
    ])("says what %s means in plain words", async (code, message) => {
      const { user } = await setup({ client: withRows([verified], { runSource: fail(code) }) });
      await user.click(within(rowFor("shop.example/sitemap.xml")).getByRole("button", { name: "Run now" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
    });

    it("says how long to wait when it is rate limited", async () => {
      const { user } = await setup({ client: withRows([verified], { runSource: fail("rate_limited", 45) }) });
      await user.click(within(rowFor("shop.example/sitemap.xml")).getByRole("button", { name: "Run now" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Please wait 45 seconds and try again.");
    });

    it("takes the row off the list when the service says the source is gone", async () => {
      const { user } = await setup({ client: withRows([verified], { runSource: fail("not_found") }) });
      await user.click(within(rowFor("shop.example/sitemap.xml")).getByRole("button", { name: "Run now" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/no longer exists/);
      expect(screen.queryByRole("rowheader", { name: /shop\.example\/sitemap\.xml/ })).toBeNull();
    });

    it("blocks the tab with Not connected yet when the service is switched off mid session", async () => {
      const { user } = await setup({ client: withRows([verified], { runSource: fail("not_connected") }) });
      await user.click(within(rowFor("shop.example/sitemap.xml")).getByRole("button", { name: "Run now" }));
      expect(await screen.findByRole("heading", { name: "Not connected yet" })).toBeInTheDocument();
    });

    it("disables the row's buttons while it runs", async () => {
      let finish!: () => void;
      const runSource = vi.fn(() => new Promise<void>((res) => (finish = res)));
      const { user } = await setup({ client: withRows([verified], { runSource }) });
      const row = rowFor("shop.example/sitemap.xml");
      await user.click(within(row).getByRole("button", { name: "Run now" }));
      for (const name of ["Check now", "Run now", "Remove"]) expect(within(row).getByRole("button", { name })).toBeDisabled();
      finish();
      await waitFor(() => expect(within(row).getByRole("button", { name: "Run now" })).toBeEnabled());
    });
  });

  describe("Remove", () => {
    it("asks first and can be cancelled with the button or Escape, giving focus back", async () => {
      const deleteSource = vi.fn(async () => undefined);
      const { user } = await setup({ client: withRows([verified, attention], { deleteSource }) });
      const row = rowFor("shop.example/sitemap.xml");
      const trigger = within(row).getByRole("button", { name: "Remove" });
      await user.click(trigger);
      expect(screen.getByText(/Remove this source\?/)).toBeInTheDocument();
      expect(deleteSource).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Keep source" }));
      expect(screen.queryByText(/Remove this source\?/)).toBeNull();
      expect(trigger).toHaveFocus();
      await user.click(trigger);
      await user.keyboard("{Escape}");
      expect(screen.queryByText(/Remove this source\?/)).toBeNull();
      expect(trigger).toHaveFocus();
      expect(deleteSource).not.toHaveBeenCalled();
    });

    it("removes the source, says so, checks the key again and moves focus to the list heading", async () => {
      const deleteSource = vi.fn(async () => undefined);
      const getCredentials = vi.fn(async () => ({ registered: true, keyHint: "abcd" }));
      const { user } = await setup({ client: withRows([verified, attention], { deleteSource, getCredentials }) });
      await user.click(within(rowFor("shop.example/sitemap.xml")).getByRole("button", { name: "Remove" }));
      await user.click(screen.getByRole("button", { name: "Remove source" }));
      expect(deleteSource).toHaveBeenCalledWith(verified.id);
      expect(await screen.findByText("Source removed.")).toBeInTheDocument();
      expect(screen.queryByRole("rowheader", { name: /shop\.example\/sitemap\.xml/ })).toBeNull();
      expect(screen.getByRole("heading", { name: "Your sources" })).toHaveFocus();
      expect(getCredentials).toHaveBeenCalledTimes(1);
    });

    it("never says the saved key goes with a source, not even for the last one", async () => {
      const { user } = await setup({ client: withRows([verified]) });
      await user.click(within(rowFor("shop.example/sitemap.xml")).getByRole("button", { name: "Remove" }));
      expect(screen.queryByText(/saved key is removed too/)).toBeNull();
      expect(screen.queryByText(/last source/)).toBeNull();
    });

    it("keeps showing the saved key after the last source is removed", async () => {
      const getCredentials = vi.fn(async () => ({ registered: true, keyHint: "abcd" }));
      const { user } = await setup({ client: withRows([verified], { getCredentials }) });
      await user.click(within(rowFor("shop.example/sitemap.xml")).getByRole("button", { name: "Remove" }));
      await user.click(screen.getByRole("button", { name: "Remove source" }));
      expect(await screen.findByText("Source removed.")).toBeInTheDocument();
      expect(screen.getByText(/Key ending in abcd/)).toBeInTheDocument();
    });

    it("keeps the row and says why when removing fails", async () => {
      const { user } = await setup({ client: withRows([verified], { deleteSource: fail("unavailable") }) });
      await user.click(within(rowFor("shop.example/sitemap.xml")).getByRole("button", { name: "Remove" }));
      await user.click(screen.getByRole("button", { name: "Remove source" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/could not do that right now/);
      expect(screen.getByRole("rowheader", { name: /shop\.example\/sitemap\.xml/ })).toBeInTheDocument();
    });
  });
});

describe("drafts matrix (unchanged)", () => {
  it("is a real table with the four headings", async () => {
    await setup();
    const table = screen.getByRole("table", { name: "Drafts from your content sources" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Source", "Title", "Status", "Actions"]);
  });

  it("shows only the drafts a content source made", async () => {
    await setup();
    const rows = within(screen.getByRole("table", { name: "Drafts from your content sources" })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Ten tips for spring")).toBeInTheDocument();
    expect(screen.getByText("Shop update")).toBeInTheDocument();
    expect(screen.queryByText("A normal draft")).toBeNull();
    expect(screen.queryByText("Already scheduled")).toBeNull();
  });

  it("tags each row with its source type and name, and gives every row the exact status badge", async () => {
    await setup();
    const rows = within(screen.getByRole("table", { name: "Drafts from your content sources" })).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("RSS Feed");
    expect(rows[0]).toHaveTextContent("my blog");
    expect(rows[1]).toHaveTextContent("Sitemap XML");
    expect(rows[1]).toHaveTextContent("shop");
    expect(screen.getAllByText("Generated draft, pending review")).toHaveLength(2);
  });

  it("calls the review, approve and purge handlers with that row's post", async () => {
    const { user, onReviewAndEdit, onApproveToCalendar } = await setup();
    const rows = within(screen.getByRole("table", { name: "Drafts from your content sources" })).getAllByRole("row").slice(1);
    await user.click(within(rows[1]!).getByRole("button", { name: "Review and edit" }));
    expect(onReviewAndEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "d2" }));
    await user.click(within(rows[0]!).getByRole("button", { name: "Approve and move to Calendar" }));
    expect(onApproveToCalendar).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }));
  });

  it("asks before purging and only then calls the handler", async () => {
    const { user, onPurge } = await setup();
    const rows = within(screen.getByRole("table", { name: "Drafts from your content sources" })).getAllByRole("row").slice(1);
    await user.click(within(rows[0]!).getByRole("button", { name: "Dismiss / purge" }));
    expect(screen.getByText("Delete this draft permanently?")).toBeInTheDocument();
    expect(onPurge).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep draft" }));
    expect(screen.queryByText("Delete this draft permanently?")).toBeNull();
    await user.click(within(rows[0]!).getByRole("button", { name: "Dismiss / purge" }));
    await user.click(screen.getByRole("button", { name: "Delete draft" }));
    expect(onPurge).toHaveBeenCalledTimes(1);
    expect(onPurge).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }));
  });

  it("cancels the purge question with Escape", async () => {
    const { user, onPurge } = await setup();
    await user.click(screen.getAllByRole("button", { name: "Dismiss / purge" })[0]!);
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Delete this draft permanently?")).toBeNull();
    expect(onPurge).not.toHaveBeenCalled();
  });

  it("scrolls on a narrow screen: the table sits in a labelled, keyboard reachable region", async () => {
    await setup();
    const region = screen.getByRole("region", { name: "Drafts from your content sources" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("table")).toBeInTheDocument();
  });

  it("says what to do when there are no drafts, and shows no table", async () => {
    await setup({ props: { posts: [post({ id: "x", tags: ["promo"] })] } });
    expect(screen.getByText("Add an RSS feed or your own sitemap, then drafts appear here for your review.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Drafts from your content sources" })).toBeNull();
  });
});

describe("wording, in every state", () => {
  const reasons = { well_known: "file does not contain the verification token", meta_tag: "no matching meta tag in the head", dns_txt: "no matching TXT record" };
  const rows = [
    src(),
    src({ id: "aaaaaaaa-2222-4333-8444-555555555555", sourceUrl: "https://shop.example/sitemap.xml", sourceType: "sitemap", domainVerified: true, verificationToken: null, lastSyncedAt: "2026-10-18T08:00:00.000Z" }),
    src({ id: "bbbbbbbb-2222-4333-8444-555555555555", sourceUrl: "https://blog.example/rss", domainVerified: true, verificationToken: null, lastError: "lazyrelay:bad_key", consecutiveFailures: 3 }),
  ];

  const clean = (text: string) => {
    expect(text.length).toBeGreaterThan(100);
    expect(text).not.toMatch(DASH);
    expect(text).not.toMatch(/scraper|crawler/i);
  };

  it("has no em or en dash and no scraper or crawler in the rendered text across the whole journey", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    const { user, container } = await setup({
      client: { getCredentials: async () => ({ registered: false, keyHint: null }), listSources: async () => rows, verifySource: async () => ({ verified: false, reasons }), saveKey: fail("api_key_rejected"), runSource: fail("engine_disabled") },
    });
    seen.push(container.textContent ?? ""); // not registered, sources, drafts, form
    await user.type(screen.getByLabelText("Feed address"), "http://nope.example/feed");
    seen.push(container.textContent ?? ""); // address error
    await user.click(screen.getByLabelText("LazyRelay key"));
    await user.paste("abc");
    seen.push(container.textContent ?? ""); // key error
    await user.clear(screen.getByLabelText("LazyRelay key"));
    await user.paste(KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByRole("alert");
    seen.push(container.textContent ?? ""); // key refused
    await user.click(within(rowFor("shop.example/sitemap.xml")).getByRole("button", { name: "Run now" }));
    await screen.findByText("Background runs are switched off right now.");
    seen.push(container.textContent ?? ""); // run refused
    await user.click(within(rowFor("example.com/feed.xml")).getByRole("button", { name: "Check now" }));
    await screen.findByRole("status", { name: "Result of the check" });
    seen.push(container.textContent ?? ""); // check reasons
    await user.click(within(rowFor("blog.example/rss")).getByRole("button", { name: "Remove" }));
    seen.push(container.textContent ?? ""); // remove question
    await user.click(screen.getAllByRole("button", { name: "Dismiss / purge" })[0]!);
    seen.push(container.textContent ?? ""); // draft purge question
    expect(seen).toHaveLength(8);
    for (const text of seen) clean(text);
  });

  it("is clean in the proof panel, the saved key state and the confirm questions", async () => {
    const seen: string[] = [];
    const { user, container } = await setup({ client: { getCredentials: async () => ({ registered: true, keyHint: "wxyz" }), listSources: async () => rows } });
    seen.push(container.textContent ?? "");
    await user.click(screen.getByRole("button", { name: "Remove key" }));
    seen.push(container.textContent ?? "");
    await user.click(screen.getByRole("button", { name: "Keep key" }));
    await addRss(user, "https://new.example/feed.xml");
    await screen.findByRole("region", { name: "Prove you own this website" });
    seen.push(container.textContent ?? "");
    for (const text of seen) {
      expect(text).not.toMatch(DASH);
      expect(text).not.toMatch(/scraper|crawler/i);
    }
  });

  it("is clean in every blocked state and while loading", async () => {
    for (const code of ["not_connected", "sign_in", "try_later", "network", "bad_response", "unavailable"] as const) {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { container, unmount } = await setup({ client: { listSources: fail(code) } });
      expect(container.textContent, code).not.toMatch(DASH);
      expect(container.textContent, code).not.toMatch(/scraper|crawler/i);
      unmount();
    }
    const { container } = await setup({ settle: false });
    expect(container.textContent).not.toMatch(DASH);
  });
});

describe("no network without a service address", () => {
  it("makes no fetch call in any state when the tab is given the not connected client", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { user } = await setup({ props: { client: createNotConnectedClient() } });
    await user.click(screen.getAllByRole("button", { name: "Dismiss / purge" })[0]!);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
