// The Brands workspace: one card per brand on the left, the selected brand's voice, numbers, channels and a 30-day chart on the right.
// Nothing is sent until Save is pressed.
import { cloneElement, type ComponentProps, type ReactElement } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/api", () => ({}));
// jsdom has no layout, so Recharts' ResponsiveContainer would draw nothing: give the chart a fixed size instead.
vi.mock("recharts", async (importOriginal) => {
  const real = await importOriginal<typeof import("recharts")>();
  return {
    ...real,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 600, height: 160 }),
  };
});
import { BrandsWorkspace } from "./BrandsWorkspace";
import type { Brand, ScheduledPost, SocialAccount } from "../../lib/api";

const acct = (id: string, platform: string, brand: string | null, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: id + "_handle", connected_at: "2026-09-01T00:00:00Z", brand_label: brand, brand_id: brand ? "b-" + brand : null, ...extra,
});
const ACCOUNTS: SocialAccount[] = [
  acct("a1", "tiktok", "Alpha Brand"), acct("a2", "facebook", "Alpha Brand"), acct("a3", "facebook", "Alpha Brand"), acct("a4", "mastodon", "Alpha Brand"),
  acct("b1", "x", "Beta Brand"),
];
const BRANDS = [
  { id: "b-Alpha Brand", name: "Alpha Brand", voice_profile: "Warm and plain.", created_at: "2026-09-01" },
  { id: "b-Beta Brand", name: "Beta Brand", voice_profile: null, created_at: "2026-09-02" },
] as Brand[];
const post = (id: string, status: string, accountId: string | null, when: string | null, paused: string | null = null) =>
  ({ id, status, social_account_id: accountId, scheduled_for: when, paused_at: paused, content: "x" }) as unknown as ScheduledPost;
const POSTS = [
  post("p1", "posted", "a1", "2026-10-20T08:00:00Z"),
  post("p2", "posted", "a2", "2026-10-21T08:00:00Z"),
  post("p3", "pending", "a1", "2026-10-25T08:00:00Z", "2026-10-19T00:00:00Z"),
  post("p4", "pending", "a2", "2026-10-26T08:00:00Z", "2026-10-19T00:00:00Z"),
  post("p5", "posted", "b1", "2026-10-21T09:00:00Z"),
];

function setup(over: Partial<ComponentProps<typeof BrandsWorkspace>> = {}) {
  const onSaveVoice = vi.fn().mockResolvedValue(undefined);
  const onOpenSocialPlatforms = vi.fn();
  render(
    <BrandsWorkspace
      brands={BRANDS} accounts={ACCOUNTS} posts={POSTS} brandCapacity={{ addons: [], baseLimit: 3, addonSlots: 2, totalLimit: 5 }}
      onSaveVoice={onSaveVoice} onOpenSocialPlatforms={onOpenSocialPlatforms} now={new Date("2026-10-21T12:00:00Z")} {...over}
    />,
  );
  return { onSaveVoice, onOpenSocialPlatforms };
}
afterEach(cleanup);

describe("brand cards", () => {
  it("shows one selectable card per brand with real account and channel counts, the first brand selected", () => {
    setup();
    const cards = screen.getAllByTestId(/^bp-card-/);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute("aria-pressed", "true");
    expect(cards[1]).toHaveAttribute("aria-pressed", "false");
    expect(within(cards[0]).getByText("Alpha Brand")).toBeInTheDocument();
    expect(cards[0]).toHaveTextContent("4 accounts");
    expect(cards[0]).toHaveTextContent("3 channels");
    expect(cards[1]).toHaveTextContent("1 account");
    expect(cards[1]).toHaveTextContent("1 channel");
  });
  it("shows n of cap brands when the plan limit is known, and nothing when it is not", () => {
    setup();
    expect(screen.getByText("2 of 5 brands")).toBeInTheDocument();
    cleanup();
    setup({ brandCapacity: null });
    expect(screen.queryByText(/of \d+ brands?/)).not.toBeInTheDocument();
  });
  it("switches the workspace to the clicked brand", async () => {
    setup();
    await userEvent.click(screen.getByTestId("bp-card-Beta Brand"));
    expect(screen.getByRole("heading", { name: "Beta Brand" })).toBeInTheDocument();
    expect(screen.getByTestId("bp-card-Beta Brand")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("workspace numbers and channels", () => {
  it("shows published in the last 30 days and paused in queue for the selected brand", async () => {
    setup();
    expect(screen.getByTestId("bp-stat-published")).toHaveTextContent("2");
    expect(screen.getByTestId("bp-stat-paused")).toHaveTextContent("2");
    await userEvent.click(screen.getByTestId("bp-card-Beta Brand"));
    expect(screen.getByTestId("bp-stat-published")).toHaveTextContent("1");
    expect(screen.getByTestId("bp-stat-paused")).toHaveTextContent("0");
  });
  it("shows channel icons, dimming the ones that are not connected, with slate icons for the mono set", () => {
    setup();
    expect(screen.getByTestId("bp-channel-tiktok")).toHaveAttribute("data-connected", "true");
    expect(screen.getByTestId("bp-channel-x")).toHaveAttribute("data-connected", "false");
    expect(screen.getByTestId("bp-channel-x").className).toMatch(/bp-ch--off/);
    expect(screen.getByTestId("bp-channel-mastodon").className).toMatch(/bp-ch--mono/);
    expect(screen.getByTestId("bp-channel-tiktok").className).not.toMatch(/bp-ch--mono/);
  });
  it("describes the 30-day chart in text for screen readers", () => {
    setup();
    expect(screen.getByRole("img", { name: /published posts per day, last 30 days/i })).toHaveAccessibleName(/2 posts/i);
  });
});

describe("brand voice", () => {
  it("shows the saved voice and sends nothing when it opens", () => {
    const { onSaveVoice } = setup();
    expect(screen.getByLabelText("Brand voice")).toHaveValue("Warm and plain.");
    expect(onSaveVoice).not.toHaveBeenCalled();
  });
  it("saves the edited voice for the selected brand only when Save is pressed", async () => {
    const { onSaveVoice } = setup();
    expect(screen.getByRole("button", { name: /save voice/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Brand voice"), { target: { value: "  Dry and short.  " } });
    expect(onSaveVoice).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /save voice/i }));
    expect(onSaveVoice).toHaveBeenCalledWith("b-Alpha Brand", "Alpha Brand", "Dry and short.");
    expect(await screen.findByText(/voice saved/i)).toBeInTheDocument();
  });
  it("sends null when the voice is cleared", async () => {
    const { onSaveVoice } = setup();
    fireEvent.change(screen.getByLabelText("Brand voice"), { target: { value: "   " } });
    await userEvent.click(screen.getByRole("button", { name: /save voice/i }));
    expect(onSaveVoice).toHaveBeenCalledWith("b-Alpha Brand", "Alpha Brand", null);
  });
  it("keeps each brand's unsaved draft when switching back and forth", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Brand voice"), { target: { value: "Draft for alpha" } });
    await userEvent.click(screen.getByTestId("bp-card-Beta Brand"));
    expect(screen.getByLabelText("Brand voice")).toHaveValue("");
    await userEvent.click(screen.getByTestId("bp-card-Alpha Brand"));
    expect(screen.getByLabelText("Brand voice")).toHaveValue("Draft for alpha");
  });
  it("shows a failure in an alert and keeps the draft text", async () => {
    const onSaveVoice = vi.fn().mockRejectedValue(new Error("Could not save the voice."));
    setup({ onSaveVoice });
    fireEvent.change(screen.getByLabelText("Brand voice"), { target: { value: "Keep me" } });
    await userEvent.click(screen.getByRole("button", { name: /save voice/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the voice.");
    expect(screen.getByLabelText("Brand voice")).toHaveValue("Keep me");
    expect(screen.getByRole("button", { name: /save voice/i })).toBeEnabled();
  });
});

describe("no brand yet", () => {
  it("explains what a brand is and points to Social Platforms, without any brand creation form", async () => {
    const { onOpenSocialPlatforms } = setup({ brands: [], brandCapacity: null });
    expect(screen.getByText(/groups your social accounts/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Brand voice")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /social platforms/i }));
    expect(onOpenSocialPlatforms).toHaveBeenCalledTimes(1);
  });
});
