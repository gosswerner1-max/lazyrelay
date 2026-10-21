// The Connections workspace: a map of the 19 platforms for the selected brand. It never connects anything itself; tiles and the button send the
// customer to the Social Platforms tab.
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/api", () => ({}));
import { ConnectionsWorkspace } from "./ConnectionsWorkspace";
import type { Brand, ScheduledPost, SocialAccount } from "../../lib/api";

const acct = (id: string, platform: string, brand: string | null, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: id, connected_at: "2026-09-01T00:00:00Z", brand_label: brand, brand_id: brand ? "b-" + brand : null, ...extra,
});
const ACCOUNTS = [
  acct("a1", "tiktok", "Alpha Brand"), acct("a2", "tiktok", "Alpha Brand"), acct("a3", "facebook", "Alpha Brand", { needs_reconnect_at: "2026-10-01T00:00:00Z" }),
  acct("a4", "whatsapp", "Alpha Brand"), acct("a5", "mastodon", "Alpha Brand"), acct("b1", "tiktok", "Beta Brand"), acct("b2", "x", "Beta Brand"),
];
const BRANDS = [{ id: "b-Alpha Brand", name: "Alpha Brand" }, { id: "b-Beta Brand", name: "Beta Brand" }] as unknown as Brand[];
const POSTS = [{ id: "p1", status: "pending", social_account_id: "a1", paused_at: "2026-10-20T00:00:00Z" }] as unknown as ScheduledPost[];

function setup(over: Partial<React.ComponentProps<typeof ConnectionsWorkspace>> = {}) {
  const onOpenSocialPlatforms = vi.fn();
  render(
    <ConnectionsWorkspace accounts={ACCOUNTS} brands={BRANDS} posts={POSTS} gcalStatus={{ last_synced_at: "2026-10-20T10:00:00Z" }} gsheetStatus={null} onOpenSocialPlatforms={onOpenSocialPlatforms} {...over} />,
  );
  return { onOpenSocialPlatforms };
}
const tile = (id: string) => screen.getByTestId("cn-tile-" + id);
afterEach(cleanup);

describe("platform tiles", () => {
  it("shows all 19 platforms, WhatsApp last, in a fixed order", () => {
    setup();
    const tiles = screen.getAllByTestId(/^cn-tile-/);
    expect(tiles).toHaveLength(19);
    expect(tiles[18].getAttribute("data-testid")).toBe("cn-tile-whatsapp");
  });
  it("starts on All brands with counts from the real accounts", () => {
    setup();
    expect(within(tile("tiktok")).getByText("3 accounts")).toBeInTheDocument();
    expect(within(tile("whatsapp")).getByText("1 account")).toBeInTheDocument();
    expect(tile("tiktok")).toHaveAttribute("data-connected", "true");
  });
  it("marks platforms with no account as not connected", () => {
    setup();
    expect(tile("youtube")).toHaveAttribute("data-connected", "false");
    expect(within(tile("youtube")).getByText("Click to Connect API")).toBeInTheDocument();
  });
  it("treats an account that needs reconnecting as not connected, with its own wording", () => {
    setup();
    expect(tile("facebook")).toHaveAttribute("data-connected", "false");
    expect(within(tile("facebook")).getByText("Needs reconnecting. Click to Connect API")).toBeInTheDocument();
  });
  it("follows the brand switch", async () => {
    setup();
    await userEvent.click(screen.getByRole("radio", { name: "Beta Brand" }));
    expect(within(tile("tiktok")).getByText("1 account")).toBeInTheDocument();
    expect(tile("mastodon")).toHaveAttribute("data-connected", "false");
    expect(tile("x")).toHaveAttribute("data-connected", "true");
    await userEvent.click(screen.getByRole("radio", { name: "All brands" }));
    expect(tile("mastodon")).toHaveAttribute("data-connected", "true");
  });
  it("draws purple-branded icons in slate", () => {
    setup();
    expect(tile("mastodon").className).toMatch(/cn-tile--mono/);
    expect(tile("tiktok").className).not.toMatch(/cn-tile--mono/);
  });
});

describe("brand switch", () => {
  it("is a segmented control: All brands plus each brand, All brands selected first", () => {
    setup();
    const radios = within(screen.getByRole("radiogroup", { name: /brand/i })).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label") ?? r.textContent)).toEqual(["All brands", "Alpha Brand", "Beta Brand"]);
    expect(screen.getByRole("radio", { name: "All brands" })).toBeChecked();
  });
});

describe("connection health", () => {
  it("shows platforms connected out of 19, accounts, reconnects and paused queues", () => {
    setup();
    const h = screen.getByTestId("cn-health");
    expect(within(h).getByTestId("cn-stat-platforms")).toHaveTextContent("4 / 19");
    expect(within(h).getByTestId("cn-stat-accounts")).toHaveTextContent("7");
    expect(within(h).getByTestId("cn-stat-reconnect")).toHaveTextContent("1");
    expect(within(h).getByTestId("cn-stat-paused")).toHaveTextContent("1");
  });
  it("recomputes for the selected brand", async () => {
    setup();
    await userEvent.click(screen.getByRole("radio", { name: "Beta Brand" }));
    const h = screen.getByTestId("cn-health");
    expect(within(h).getByTestId("cn-stat-platforms")).toHaveTextContent("2 / 19");
    expect(within(h).getByTestId("cn-stat-paused")).toHaveTextContent("0");
  });
});

describe("integrations", () => {
  it("shows Calendar connected with last synced time, Sheets not connected, WhatsApp from accounts", () => {
    setup();
    const i = screen.getByTestId("cn-integrations");
    expect(within(i).getByTestId("cn-int-gcal")).toHaveTextContent(/connected/i);
    expect(within(i).getByTestId("cn-int-gcal")).toHaveTextContent(/last synced/i);
    expect(within(i).getByTestId("cn-int-gsheet")).toHaveTextContent(/not connected/i);
    expect(within(i).getByTestId("cn-int-whatsapp")).toHaveTextContent(/1 number/i);
  });
  it("says checking while Google status is still loading", () => {
    setup({ gcalStatus: undefined, gsheetStatus: undefined });
    expect(screen.getByTestId("cn-int-gcal")).toHaveTextContent(/checking/i);
  });
});

describe("opening Social Platforms", () => {
  it("sends the customer there from a connected tile without a message", async () => {
    const { onOpenSocialPlatforms } = setup();
    await userEvent.click(tile("tiktok"));
    expect(onOpenSocialPlatforms).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("sends them there from an unconnected tile and says what to do", async () => {
    const { onOpenSocialPlatforms } = setup();
    await userEvent.click(tile("youtube"));
    expect(onOpenSocialPlatforms).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Open Social Platforms to connect YouTube");
  });
  it("has a Manage connections button that does the same", async () => {
    const { onOpenSocialPlatforms } = setup();
    await userEvent.click(screen.getByRole("button", { name: /manage connections/i }));
    expect(onOpenSocialPlatforms).toHaveBeenCalledTimes(1);
  });
});

describe("empty account", () => {
  it("renders a friendly empty state with every tile unconnected", () => {
    setup({ accounts: [], brands: [], posts: [] });
    expect(screen.getByText(/no platforms connected yet/i)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^cn-tile-/)).toHaveLength(19);
    expect(screen.getByTestId("cn-stat-platforms")).toHaveTextContent("0 / 19");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });
});
