import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ContentSourcesTab from "./ContentSourcesTab";
import { CSV_MAX_BYTES, type ContentSourcesClient } from "../../lib/contentSources";
import { createMockContentSourcesClient } from "../../lib/contentSourcesMock";
import type { Brand, ScheduledPost } from "../../lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DASH = /[–—]/;

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

function setup(over: Partial<React.ComponentProps<typeof ContentSourcesTab>> = {}) {
  const handlers = { onReviewAndEdit: vi.fn(), onApproveToCalendar: vi.fn(), onPurge: vi.fn() };
  const utils = render(<ContentSourcesTab posts={posts} brands={brands} {...handlers} {...over} />);
  return { ...utils, ...handlers, user: userEvent.setup({ applyAccept: false }) };
}

// The status line is always on the page (a live region is announced best when it already exists), so wait for its words.
const statusIs = (words: RegExp | string) => waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(words));

const verifyButton = () => screen.getByRole("button", { name: "Verify Source Integrity" });

describe("source type toggle", () => {
  it("is a radiogroup with the three choices, RSS Feed first and chosen", () => {
    setup();
    const group = screen.getByRole("radiogroup", { name: "Source type" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual(["RSS Feed", "Sitemap XML", "CSV Bulk Upload"]);
    expect(screen.getByRole("radio", { name: "RSS Feed" })).toBeChecked();
  });

  it("changes with a click and with the arrow keys", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("radio", { name: "Sitemap XML" }));
    expect(screen.getByRole("radio", { name: "Sitemap XML" })).toBeChecked();
    screen.getByRole("radio", { name: "Sitemap XML" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "CSV Bulk Upload" })).toBeChecked();
  });

  it("shows an address field for RSS and Sitemap and a file picker for CSV", async () => {
    const { user } = setup();
    expect(screen.getByLabelText("Feed address")).toHaveAttribute("type", "url");
    await user.click(screen.getByRole("radio", { name: "Sitemap XML" }));
    expect(screen.getByLabelText("Sitemap address")).toHaveAttribute("type", "url");
    await user.click(screen.getByRole("radio", { name: "CSV Bulk Upload" }));
    expect(screen.queryByLabelText("Sitemap address")).toBeNull();
    const file = screen.getByLabelText("CSV file") as HTMLInputElement;
    expect(file.type).toBe("file");
    expect(file.accept).toContain(".csv");
  });
});

describe("address field", () => {
  it("is trimmed-length limited to 2048 and linked to its hint", () => {
    setup();
    const input = screen.getByLabelText("Feed address");
    expect(input).toHaveAttribute("maxlength", "2048");
    const hintId = input.getAttribute("aria-describedby")!.split(" ")[0];
    expect(document.getElementById(hintId)).toBeInTheDocument();
  });

  it("starts with the Verify button disabled and no error", () => {
    setup();
    expect(verifyButton()).toBeDisabled();
    expect(screen.getByLabelText("Feed address")).not.toHaveAttribute("aria-invalid", "true");
  });

  it.each([
    ["http://example.com/feed", /https/i],
    ["https://user:pass@example.com/feed", /username|password/i],
    ["https://192.168.1.5/feed", /private|local/i],
    ["https://localhost/feed", /private|local/i],
    ["https://[::1]/feed", /private|local/i],
  ])("rejects %s with a plain message under the field", async (value, message) => {
    const { user } = setup();
    const input = screen.getByLabelText("Feed address");
    await user.click(input);
    await user.paste(value); // paste, because typing treats [ as the start of a key name
    expect(input).toHaveAttribute("aria-invalid", "true");
    const errorId = input.getAttribute("aria-describedby")!.split(" ").find((id) => document.getElementById(id)?.className.includes("cs-error"))!;
    expect(document.getElementById(errorId)).toHaveTextContent(message);
    expect(verifyButton()).toBeDisabled();
  });

  it("accepts a valid https address and enables Verify", async () => {
    const { user } = setup();
    const input = screen.getByLabelText("Feed address");
    await user.type(input, "https://example.com/feed.xml");
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(verifyButton()).toBeEnabled();
  });
});

describe("CSV picker", () => {
  async function pick(user: ReturnType<typeof userEvent.setup>, file: File) {
    await user.click(screen.getByRole("radio", { name: "CSV Bulk Upload" }));
    await user.upload(screen.getByLabelText("CSV file"), file);
  }

  it("rejects a file that is not .csv", async () => {
    const { user } = setup();
    await pick(user, new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(screen.getByLabelText("CSV file")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/ends in \.csv/i)).toBeInTheDocument();
    expect(verifyButton()).toBeDisabled();
  });

  it("rejects a file over 5 MB", async () => {
    const { user } = setup();
    const big = new File(["x"], "big.csv", { type: "text/csv" });
    Object.defineProperty(big, "size", { value: CSV_MAX_BYTES + 1 });
    await pick(user, big);
    expect(screen.getByText(/too big/i)).toBeInTheDocument();
    expect(verifyButton()).toBeDisabled();
  });

  it("accepts a .csv file and enables Verify", async () => {
    const { user } = setup();
    await pick(user, new File(["a,b\n1,2"], "posts.csv", { type: "text/csv" }));
    expect(screen.getByLabelText("CSV file")).not.toHaveAttribute("aria-invalid", "true");
    expect(verifyButton()).toBeEnabled();
  });
});

describe("Verify Source Integrity", () => {
  async function verifyWith(client: ContentSourcesClient | undefined) {
    const utils = setup({ client });
    await utils.user.type(screen.getByLabelText("Feed address"), "https://example.com/feed.xml");
    await utils.user.click(verifyButton());
    return utils;
  }

  it("shows Verified", async () => {
    await verifyWith(createMockContentSourcesClient({ verify: { status: "verified" } }));
    await statusIs(/^Verified/);
  });

  it("shows Could not verify with the reason", async () => {
    await verifyWith(createMockContentSourcesClient({ verify: { status: "failed", reason: "The feed is empty." } }));
    await statusIs(/^Could not verify/);
    await statusIs("The feed is empty.");
  });

  it("shows Not connected yet with the default client, and makes no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await verifyWith(undefined);
    await statusIs(/^Not connected yet/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the trimmed address, the type and the chosen brand, and clears the answer when the input changes", async () => {
    const client = { verifySource: vi.fn().mockResolvedValue({ status: "verified" }), addSource: vi.fn() };
    const { user } = setup({ client });
    await user.click(screen.getByRole("radio", { name: "Sitemap XML" }));
    await user.type(screen.getByLabelText("Sitemap address"), "  https://example.com/sitemap.xml  ");
    await user.selectOptions(screen.getByLabelText("Target brand"), "b2");
    await user.click(verifyButton());
    expect(client.verifySource).toHaveBeenCalledWith({ type: "sitemap", url: "https://example.com/sitemap.xml", brandId: "b2" });
    await statusIs(/^Verified/);
    await user.type(screen.getByLabelText("Sitemap address"), "x");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("sends a CSV file", async () => {
    const client = { verifySource: vi.fn().mockResolvedValue({ status: "verified" }), addSource: vi.fn() };
    const { user } = setup({ client });
    const file = new File(["a,b"], "posts.csv", { type: "text/csv" });
    await user.click(screen.getByRole("radio", { name: "CSV Bulk Upload" }));
    await user.upload(screen.getByLabelText("CSV file"), file);
    await user.click(verifyButton());
    expect(client.verifySource).toHaveBeenCalledWith({ type: "csv", file, brandId: null });
  });

  it("disables the button while a check is running", async () => {
    let finish!: (r: { status: "verified" }) => void;
    const client = { verifySource: vi.fn(() => new Promise<{ status: "verified" }>((res) => (finish = res))), addSource: vi.fn() };
    const { user } = setup({ client });
    await user.type(screen.getByLabelText("Feed address"), "https://example.com/feed.xml");
    await user.click(verifyButton());
    expect(verifyButton()).toBeDisabled();
    finish({ status: "verified" });
    await waitFor(() => expect(verifyButton()).toBeEnabled());
  });
});

describe("Target brand", () => {
  it("lists No brand first, then the account's brands", () => {
    setup();
    const select = screen.getByLabelText("Target brand") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["No brand", "Acme", "Zeta"]);
    expect(select.value).toBe("");
  });

  it("still works when the account has no brands", () => {
    setup({ brands: [] });
    expect([...(screen.getByLabelText("Target brand") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["No brand"]);
  });
});

describe("drafts matrix", () => {
  it("is a real table with the four headings", () => {
    setup();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Source", "Title", "Status", "Actions"]);
  });

  it("shows only the drafts a content source made", () => {
    setup();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Ten tips for spring")).toBeInTheDocument();
    expect(screen.getByText("Shop update")).toBeInTheDocument();
    expect(screen.queryByText("A normal draft")).toBeNull();
    expect(screen.queryByText("Already scheduled")).toBeNull();
  });

  it("tags each row with its source type and name", () => {
    setup();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("RSS Feed");
    expect(rows[0]).toHaveTextContent("my blog");
    expect(rows[1]).toHaveTextContent("Sitemap XML");
    expect(rows[1]).toHaveTextContent("shop");
  });

  it("gives every row the exact status badge", () => {
    setup();
    expect(screen.getAllByText("Generated draft, pending review")).toHaveLength(2);
  });

  it("calls the review, approve and purge handlers with that row's post", async () => {
    const { user, onReviewAndEdit, onApproveToCalendar } = setup();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    await user.click(within(rows[1]).getByRole("button", { name: "Review and edit" }));
    expect(onReviewAndEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "d2" }));
    await user.click(within(rows[0]).getByRole("button", { name: "Approve and move to Calendar" }));
    expect(onApproveToCalendar).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }));
  });

  it("asks before purging and only then calls the handler", async () => {
    const { user, onPurge } = setup();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    await user.click(within(rows[0]).getByRole("button", { name: "Dismiss / purge" }));
    expect(screen.getByText("Delete this draft permanently?")).toBeInTheDocument();
    expect(onPurge).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep draft" }));
    expect(screen.queryByText("Delete this draft permanently?")).toBeNull();
    expect(onPurge).not.toHaveBeenCalled();
    await user.click(within(rows[0]).getByRole("button", { name: "Dismiss / purge" }));
    await user.click(screen.getByRole("button", { name: "Delete draft" }));
    expect(onPurge).toHaveBeenCalledTimes(1);
    expect(onPurge).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }));
  });

  it("cancels the purge question with Escape", async () => {
    const { user, onPurge } = setup();
    await user.click(within(screen.getByRole("table")).getAllByRole("button", { name: "Dismiss / purge" })[0]);
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Delete this draft permanently?")).toBeNull();
    expect(onPurge).not.toHaveBeenCalled();
  });

  it("scrolls on a narrow screen: the table sits in a labelled, keyboard reachable region", () => {
    setup();
    const region = screen.getByRole("region", { name: "Drafts from your content sources" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("table")).toBeInTheDocument();
  });
});

describe("empty state", () => {
  it("says what to do and shows no table", () => {
    setup({ posts: [post({ id: "x", tags: ["promo"] })] });
    expect(screen.getByText("Add an RSS feed, your own sitemap or a CSV file, then drafts appear here for your review.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("is shown with no posts at all", () => {
    setup({ posts: [] });
    expect(screen.getByText(/then drafts appear here/)).toBeInTheDocument();
  });
});

describe("wording", () => {
  async function collectText(): Promise<string> {
    const { user, container } = setup();
    await user.type(screen.getByLabelText("Feed address"), "http://nope.example/feed");
    const a = container.textContent ?? "";
    await user.clear(screen.getByLabelText("Feed address"));
    await user.type(screen.getByLabelText("Feed address"), "https://example.com/feed.xml");
    await user.click(verifyButton());
    await statusIs(/^Not connected yet/);
    await user.click(screen.getAllByRole("button", { name: "Dismiss / purge" })[0]);
    const b = container.textContent ?? "";
    await user.click(screen.getByRole("radio", { name: "CSV Bulk Upload" }));
    await user.upload(screen.getByLabelText("CSV file"), new File(["x"], "n.txt"));
    return a + b + (container.textContent ?? "");
  }

  it("has no em or en dash and no scraper or crawler anywhere in the rendered text", async () => {
    const text = await collectText();
    expect(text.length).toBeGreaterThan(200);
    expect(text).not.toMatch(DASH);
    expect(text).not.toMatch(/scraper|crawler/i);
  });

  it("has no em or en dash with no drafts either", () => {
    const { container } = setup({ posts: [], brands: [] });
    expect(container.textContent).not.toMatch(DASH);
  });

  it("sits under the .content-sources wrapper", () => {
    const { container } = setup();
    expect(container.firstElementChild).toHaveClass("content-sources");
  });

  it("does not submit a page form on Enter", () => {
    const { container } = setup();
    const form = container.querySelector("form");
    const notPrevented = fireEvent.submit(form!);
    expect(notPrevented).toBe(false);
  });
});
