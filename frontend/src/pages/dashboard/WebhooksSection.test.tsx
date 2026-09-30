import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  regenerateWebhookSecret: vi.fn(),
  testWebhook: vi.fn(),
  listWebhookDeliveries: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

import { WebhooksSection } from "./WebhooksSection";

// En-dash and em-dash, built from code points so no literal dash sits in this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const EVENTS = ["post.verified", "post.failed", "post.unconfirmed", "channel.needs_reconnect"];
const CHANNELS = [
  { id: "sa1", label: "Pinterest: LazyRelay" },
  { id: "sa2", label: "Threads: shop" },
];

const endpoint = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  label: "Zapier",
  url: "https://hooks.example.org/in",
  events: [],
  socialAccountIds: null,
  enabled: true,
  createdAt: "2026-10-01T08:00:00Z",
  lastDelivery: null,
  ...over,
});
const list = (endpoints: unknown[], maxEndpoints = 5) => ({ maxEndpoints, availableEvents: EVENTS, endpoints });

// Vitest globals are off here, so testing-library does not auto-clean between tests.
afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listWebhooks.mockResolvedValue(list([]));
});

const setup = () => render(<WebhooksSection channels={CHANNELS} onError={() => {}} />);

describe("WebhooksSection", () => {
  it("shows an empty state, then the endpoints with their events, channels and health", async () => {
    api.listWebhooks.mockResolvedValue(
      list([
        endpoint({ lastDelivery: { status: "delivered", createdAt: "2026-10-01T08:00:00Z", statusCode: 200, error: null } }),
        endpoint({ id: "e2", label: "Alerts", events: ["post.failed"], socialAccountIds: ["sa2"], enabled: false }),
      ]),
    );
    setup();
    expect(await screen.findByText("Zapier")).toBeInTheDocument();
    expect(screen.getByText(/All events\. All channels\./)).toBeInTheDocument();
    expect(screen.getByText(/Last delivery worked/)).toBeInTheDocument();
    expect(screen.getByText(/Post failed\. Threads: shop\./)).toBeInTheDocument();
    expect(screen.getByText("(turned off)")).toBeInTheDocument();
  });

  it("says so when there are none", async () => {
    setup();
    expect(await screen.findByText("No webhook endpoints yet.")).toBeInTheDocument();
  });

  it("adds an endpoint for all events by default and shows the secret once", async () => {
    api.createWebhook.mockResolvedValue({ ...endpoint(), secret: "abc123secret" });
    setup();
    await screen.findByText("No webhook endpoints yet.");
    await userEvent.type(screen.getByLabelText("Endpoint URL"), "https://hooks.example.org/in");
    await userEvent.click(screen.getByRole("button", { name: "Add endpoint" }));

    await waitFor(() => expect(api.createWebhook).toHaveBeenCalledTimes(1));
    expect(api.createWebhook).toHaveBeenCalledWith({ url: "https://hooks.example.org/in", events: [], socialAccountIds: null });
    expect(await screen.findByText("Copy this secret now.")).toBeInTheDocument();
    expect(screen.getByText("abc123secret")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("abc123secret")).not.toBeInTheDocument();
  });

  it("sends only the events and channels the customer ticked", async () => {
    api.createWebhook.mockResolvedValue({ ...endpoint(), secret: "s" });
    setup();
    await screen.findByText("No webhook endpoints yet.");
    await userEvent.type(screen.getByLabelText("Endpoint URL"), "https://hooks.example.org/in");
    await userEvent.type(screen.getByLabelText("Name"), "Alerts");
    for (const name of ["Post confirmed live", "Post sent, not confirmed", "Account needs reconnecting"]) {
      await userEvent.click(screen.getByLabelText(name));
    }
    await userEvent.click(screen.getByLabelText("Threads: shop"));
    await userEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    await waitFor(() => expect(api.createWebhook).toHaveBeenCalled());
    expect(api.createWebhook).toHaveBeenCalledWith({ url: "https://hooks.example.org/in", label: "Alerts", events: ["post.failed"], socialAccountIds: ["sa2"] });
  });

  it("will not add an endpoint with every event unticked", async () => {
    setup();
    await screen.findByText("No webhook endpoints yet.");
    await userEvent.type(screen.getByLabelText("Endpoint URL"), "https://hooks.example.org/in");
    for (const name of ["Post confirmed live", "Post failed", "Post sent, not confirmed", "Account needs reconnecting"]) {
      await userEvent.click(screen.getByLabelText(name));
    }
    expect(screen.getByRole("button", { name: "Add endpoint" })).toBeDisabled();
  });

  it("the Send test button reports success and failure in plain words", async () => {
    api.listWebhooks.mockResolvedValue(list([endpoint()]));
    api.testWebhook.mockResolvedValueOnce({ delivered: true, statusCode: 200, error: null });
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Send test" }));
    expect(await screen.findByText("Test delivered (200).")).toBeInTheDocument();

    api.testWebhook.mockResolvedValueOnce({ delivered: false, statusCode: 500, error: "The endpoint answered 500." });
    await userEvent.click(screen.getByRole("button", { name: "Send test" }));
    expect(await screen.findByText("Test failed (500). The endpoint answered 500.")).toBeInTheDocument();
  });

  it("removing asks first, and does nothing if the customer says no", async () => {
    api.listWebhooks.mockResolvedValue(list([endpoint()]));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(confirm).toHaveBeenCalled();
    expect(api.deleteWebhook).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    api.deleteWebhook.mockResolvedValue({ deleted: true });
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.deleteWebhook).toHaveBeenCalledWith("e1"));
    confirm.mockRestore();
  });

  it("a new secret is shown once", async () => {
    api.listWebhooks.mockResolvedValue(list([endpoint()]));
    api.regenerateWebhookSecret.mockResolvedValue({ secret: "brand-new-secret" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "New secret" }));
    expect(await screen.findByText("brand-new-secret")).toBeInTheDocument();
  });

  it("at the limit the form is off and says why", async () => {
    api.listWebhooks.mockResolvedValue(list([endpoint({ id: "a" }), endpoint({ id: "b" })], 2));
    setup();
    expect(await screen.findByText(/up to 2 endpoints/)).toBeInTheDocument();
    expect(screen.getByLabelText("Endpoint URL")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add endpoint" })).toBeDisabled();
  });

  it("recent deliveries opens a log in plain words", async () => {
    api.listWebhooks.mockResolvedValue(list([endpoint()]));
    api.listWebhookDeliveries.mockResolvedValue({
      deliveries: [{ id: "d1", event: "post.failed", status: "failed", attempts: 6, statusCode: 500, error: "Gave up after 6 attempts.", createdAt: "2026-10-01T08:00:00Z", deliveredAt: null }],
    });
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Recent deliveries" }));
    expect(await screen.findByText(/Post failed: Failed after 6 attempts: Gave up after 6 attempts\./)).toBeInTheDocument();
  });

  it("has no en or em dashes in its copy", async () => {
    api.listWebhooks.mockResolvedValue(list([endpoint()]));
    const { container } = setup();
    await screen.findByText("Zapier");
    expect(container.textContent).not.toMatch(DASHES);
  });
});
