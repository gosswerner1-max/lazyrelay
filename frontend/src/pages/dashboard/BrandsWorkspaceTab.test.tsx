// The connected Brands workspace tab: reads accounts, brands and posts from the dashboard state and saves a voice through the existing brand API only when asked.
import { cloneElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ updateBrand: vi.fn() }));
vi.mock("../../lib/api", () => ({ api }));
vi.mock("recharts", async (importOriginal) => {
  const real = await importOriginal<typeof import("recharts")>();
  return { ...real, ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 600, height: 160 }) };
});
const ctx = vi.hoisted(() => ({
  accounts: [{ id: "a1", platform: "tiktok", platform_account_id: "a1", display_name: "alpha", connected_at: "2026-09-01", brand_label: "Alpha Brand", brand_id: "b1" }],
  brands: [{ id: "b1", name: "Alpha Brand", voice_profile: "Warm.", created_at: "2026-09-01" }] as unknown[],
  posts: [] as unknown[],
  brandCapacity: { addons: [], baseLimit: 3, addonSlots: 0, totalLimit: 3 } as unknown,
  setTab: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));

import { BrandsWorkspaceTab } from "./BrandsWorkspaceTab";

beforeEach(() => {
  api.updateBrand.mockReset().mockResolvedValue({ id: "b1" });
  ctx.refresh.mockReset().mockResolvedValue(undefined);
  ctx.setTab.mockReset();
  ctx.brands = [{ id: "b1", name: "Alpha Brand", voice_profile: "Warm.", created_at: "2026-09-01" }];
});
afterEach(cleanup);

describe("BrandsWorkspaceTab", () => {
  it("makes no API call when it opens", () => {
    render(<BrandsWorkspaceTab />);
    expect(api.updateBrand).not.toHaveBeenCalled();
    expect(ctx.refresh).not.toHaveBeenCalled();
  });
  it("shows the plan limit from the dashboard state", () => {
    render(<BrandsWorkspaceTab />);
    expect(screen.getByText("1 of 3 brands")).toBeInTheDocument();
  });
  it("saves the voice through api.updateBrand(id, name, voice), then refreshes the dashboard", async () => {
    render(<BrandsWorkspaceTab />);
    fireEvent.change(screen.getByLabelText("Brand voice"), { target: { value: "Plain and dry." } });
    await userEvent.click(screen.getByRole("button", { name: /save voice/i }));
    await waitFor(() => expect(api.updateBrand).toHaveBeenCalledTimes(1));
    expect(api.updateBrand).toHaveBeenCalledWith("b1", "Alpha Brand", "Plain and dry.");
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalledTimes(1));
  });
  it("shows an API failure in an alert, keeps the draft and does not refresh", async () => {
    api.updateBrand.mockRejectedValue(new Error("Brand not found."));
    render(<BrandsWorkspaceTab />);
    fireEvent.change(screen.getByLabelText("Brand voice"), { target: { value: "Keep me" } });
    await userEvent.click(screen.getByRole("button", { name: /save voice/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Brand not found.");
    expect(screen.getByLabelText("Brand voice")).toHaveValue("Keep me");
    expect(ctx.refresh).not.toHaveBeenCalled();
  });
  it("sends the customer to the Social Platforms tab from the empty state", async () => {
    ctx.brands = [];
    render(<BrandsWorkspaceTab />);
    await userEvent.click(screen.getByRole("button", { name: /social platforms/i }));
    expect(ctx.setTab).toHaveBeenCalledWith("Social Platforms");
  });
});
