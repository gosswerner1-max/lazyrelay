// The Posting workspace: one sliding row of channels, a composer, queue numbers and live previews. The brand dropdown decides which channels are
// in colour (connected for that brand) and which sit at 35% (not connected). Nothing is sent until a button is pressed.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/api", () => ({}));
import { PostingWorkspace } from "./PostingWorkspace";
import type { Brand, ScheduledPost, SocialAccount } from "../../lib/api";

const acct = (id: string, platform: string, brand: string | null, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: id + "_handle", connected_at: "2026-09-01T00:00:00Z", brand_label: brand, brand_id: brand ? "b-" + brand : null, ...extra,
});
const ACCOUNTS: SocialAccount[] = [
  acct("a1", "tiktok", "LazyRelay"), acct("a2", "facebook", "LazyRelay"), acct("a3", "facebook", "LazyRelay"), acct("a4", "x", "LazyRelay"), acct("a5", "whatsapp", "LazyRelay"),
  acct("a6", "facebook", "TimeAJob"), acct("a7", "tiktok", "TimeAJob"),
];
const BRANDS = [{ id: "b-LazyRelay", name: "LazyRelay" }, { id: "b-TimeAJob", name: "TimeAJob" }] as unknown as Brand[];
const POSTS = [
  { id: "p1", status: "pending", social_account_id: "a1", scheduled_for: "2026-10-22T08:00:00Z", paused_at: "2026-10-20T00:00:00Z", content: "x" },
  { id: "p2", status: "draft", social_account_id: null, scheduled_for: null, paused_at: null, content: "y" },
] as unknown as ScheduledPost[];

const setup = (over: Partial<React.ComponentProps<typeof PostingWorkspace>> = {}) => {
  const onSaveDraft = vi.fn().mockResolvedValue(undefined);
  const onSchedule = vi.fn().mockResolvedValue(undefined);
  render(<PostingWorkspace accounts={ACCOUNTS} brands={BRANDS} posts={POSTS} onSaveDraft={onSaveDraft} onSchedule={onSchedule} now={new Date("2026-10-21T12:00:00Z")} {...over} />);
  return { onSaveDraft, onSchedule };
};
const chipByTestId = (id: string) => screen.getByTestId("pw-chip-" + id);

beforeEach(() => {
  // jsdom has no layout: give the sliding row a width so the arrows can tell where the ends are.
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return this.dataset?.testid === "pw-track" ? 1000 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.dataset?.testid === "pw-track" ? 300 : 0; } });
  HTMLElement.prototype.scrollBy = vi.fn() as unknown as typeof HTMLElement.prototype.scrollBy;
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("channel slider", () => {
  it("shows all 19 channels in a single sliding row, WhatsApp last", () => {
    setup();
    const track = screen.getByTestId("pw-track");
    const chips = within(track).getAllByTestId(/^pw-chip-/);
    expect(chips).toHaveLength(19);
    expect(chips[chips.length - 1].getAttribute("data-testid")).toBe("pw-chip-whatsapp");
  });
  it("has left and right arrows that slide the row, and the left one is dimmed at the start", () => {
    setup();
    const prev = screen.getByRole("button", { name: /previous channels/i });
    const next = screen.getByRole("button", { name: /next channels/i });
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();
    fireEvent.click(next);
    expect(HTMLElement.prototype.scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number) }));
    const arg = (HTMLElement.prototype.scrollBy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { left: number };
    expect(arg.left).toBeGreaterThan(0);
  });
  it("dims the right arrow once the row is scrolled to its end", () => {
    setup();
    const track = screen.getByTestId("pw-track");
    track.scrollLeft = 700;
    fireEvent.scroll(track);
    expect(screen.getByRole("button", { name: /next channels/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /previous channels/i })).toBeEnabled();
  });
});

describe("brand dropdown and connected state", () => {
  it("shows connected channels of the first brand in colour and the rest at 35%", () => {
    setup();
    expect(screen.getByLabelText(/brand/i)).toHaveValue("LazyRelay");
    expect(chipByTestId("tiktok")).toHaveAttribute("data-connected", "true");
    expect(chipByTestId("whatsapp")).toHaveAttribute("data-connected", "true");
    expect(chipByTestId("youtube")).toHaveAttribute("data-connected", "false");
    expect(chipByTestId("youtube").className).toMatch(/pw-chip--off/);
    expect(chipByTestId("tiktok").className).not.toMatch(/pw-chip--off/);
  });
  it("switching brand re-renders the grid from that brand's own accounts, keeping the grid the same size", async () => {
    setup();
    await userEvent.selectOptions(screen.getByLabelText(/brand/i), "TimeAJob");
    expect(chipByTestId("tiktok")).toHaveAttribute("data-connected", "true");
    expect(chipByTestId("facebook")).toHaveAttribute("data-connected", "true");
    expect(chipByTestId("x")).toHaveAttribute("data-connected", "false");
    expect(chipByTestId("whatsapp")).toHaveAttribute("data-connected", "false");
    expect(screen.getAllByTestId(/^pw-chip-/)).toHaveLength(19);
  });
  it("only connected channels are ticked after a brand switch, never an unconnected one", async () => {
    setup();
    // the first three connected channels (TikTok, Facebook, X) start ticked; WhatsApp is connected too, so tick it
    expect(chipByTestId("x")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(chipByTestId("whatsapp"));
    expect(chipByTestId("whatsapp")).toHaveAttribute("aria-pressed", "true");
    await userEvent.selectOptions(screen.getByLabelText(/brand/i), "TimeAJob");
    expect(chipByTestId("x")).toHaveAttribute("aria-pressed", "false");
    expect(chipByTestId("whatsapp")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("button", { pressed: true }).length).toBeGreaterThan(0);
  });
  it("clicking a channel that is not connected explains how to connect it and ticks nothing", () => {
    setup();
    fireEvent.click(chipByTestId("youtube"));
    expect(screen.getByRole("status")).toHaveTextContent(/not connected for LazyRelay/i);
    expect(screen.getByRole("status")).toHaveTextContent(/click to connect api/i);
    expect(chipByTestId("youtube")).toHaveAttribute("aria-pressed", "false");
  });
  it("a channel whose account needs reconnecting is treated as not connected", () => {
    setup({ accounts: [...ACCOUNTS, acct("a8", "pinterest", "LazyRelay", { needs_reconnect_at: "2026-10-01T00:00:00Z" })] });
    expect(chipByTestId("pinterest")).toHaveAttribute("data-connected", "false");
    expect(chipByTestId("pinterest").getAttribute("title")).toMatch(/reconnect/i);
  });
});

describe("composer, previews and limits", () => {
  it("previews follow the caption for every ticked channel and show the character count", async () => {
    setup();
    await userEvent.type(screen.getByLabelText(/caption/i), "Hello world");
    const previews = screen.getByTestId("pw-previews");
    expect(within(previews).getAllByText("Hello world").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/11 characters/i)).toBeInTheDocument();
  });
  it("warns when the caption is over the tightest limit of the ticked channels", async () => {
    setup();
    expect(chipByTestId("x")).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText(/caption/i), { target: { value: "a".repeat(300) } });
    expect(screen.getByTestId("pw-limit")).toHaveTextContent(/280/);
    expect(screen.getByTestId("pw-limit").className).toMatch(/pw-over/);
  });
  it("shows the queue numbers for the selected brand, and says the paused queue publishes nothing", () => {
    setup();
    const metrics = screen.getByTestId("pw-metrics");
    expect(within(metrics).getByText("In queue, paused").parentElement).toHaveTextContent("1");
    expect(metrics).toHaveTextContent(/paused/i);
  });
});

describe("saving and scheduling", () => {
  it("disables both buttons until there is a caption", () => {
    setup();
    expect(screen.getByRole("button", { name: /save draft/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /schedule post/i })).toBeDisabled();
  });
  it("saves a draft with the caption and the accounts of the ticked channels", async () => {
    const { onSaveDraft } = setup();
    fireEvent.change(screen.getByLabelText(/caption/i), { target: { value: "My draft" } });
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    const arg = onSaveDraft.mock.calls[0][0];
    expect(arg.content).toBe("My draft");
    expect(arg.plannedAccountIds.sort()).toEqual(["a1", "a2", "a3", "a4"]);
  });
  it("schedules for every account of every ticked channel at the chosen date and time", async () => {
    const { onSchedule } = setup();
    fireEvent.change(screen.getByLabelText(/caption/i), { target: { value: "Go live" } });
    fireEvent.change(screen.getByLabelText(/^date/i), { target: { value: "2026-10-28" } });
    fireEvent.change(screen.getByLabelText(/^time/i), { target: { value: "18:00" } });
    await userEvent.click(screen.getByRole("button", { name: /schedule post/i }));
    expect(onSchedule).toHaveBeenCalledTimes(1);
    const arg = onSchedule.mock.calls[0][0];
    expect(arg.content).toBe("Go live");
    expect(arg.accountIds.sort()).toEqual(["a1", "a2", "a3", "a4"]);
    expect(new Date(arg.scheduledFor).getTime()).toBe(new Date("2026-10-28T18:00").getTime());
  });
  it("will not schedule without a date and time, and says so", async () => {
    const { onSchedule } = setup();
    fireEvent.change(screen.getByLabelText(/caption/i), { target: { value: "Go live" } });
    fireEvent.change(screen.getByLabelText(/^date/i), { target: { value: "" } });
    await userEvent.click(screen.getByRole("button", { name: /schedule post/i }));
    expect(onSchedule).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/date and a time/i);
  });
  it("shows a failure from the server and keeps the caption", async () => {
    const onSaveDraft = vi.fn().mockRejectedValue(new Error("Plan limit reached"));
    setup({ onSaveDraft });
    fireEvent.change(screen.getByLabelText(/caption/i), { target: { value: "Keep me" } });
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Plan limit reached");
    expect(screen.getByLabelText(/caption/i)).toHaveValue("Keep me");
  });
  it("sends nothing on its own: mounting and typing never call the handlers", () => {
    const { onSaveDraft, onSchedule } = setup();
    fireEvent.change(screen.getByLabelText(/caption/i), { target: { value: "typing" } });
    expect(onSaveDraft).not.toHaveBeenCalled();
    expect(onSchedule).not.toHaveBeenCalled();
  });
});

describe("palette", () => {
  it("never draws a channel icon in a purple or violet brand colour", () => {
    setup();
    for (const id of ["mastodon", "discord", "slack"]) {
      expect(chipByTestId(id).className).toMatch(/pw-chip--mono/);
    }
  });
});
