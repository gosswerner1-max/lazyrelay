import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BillingMockupPage } from "./BillingMockupPage";
import { MOCK_SCENARIOS } from "../../dev/billingMockScenarios";

afterEach(cleanup);

describe("BillingMockupPage", () => {
  it("offers the eight scenarios in a plain select and starts on the healthy one", () => {
    render(<BillingMockupPage />);
    const select = screen.getByRole("combobox");
    expect(within(select).getAllByRole("option")).toHaveLength(8);
    expect(MOCK_SCENARIOS.map((s) => s.label)).toContain("Critical balance (red, flashing)");
    expect(screen.getByText("Available Balance: 2,030 Credits")).toBeInTheDocument();
    expect(screen.getByTestId("billing-total")).toHaveTextContent("2,030");
  });

  it("changes the nav indicator and the tab together when the scenario changes", async () => {
    render(<BillingMockupPage />);
    await userEvent.selectOptions(screen.getByRole("combobox"), "critical");
    expect(screen.getByRole("img", { name: "Balance is critically low" })).toBeInTheDocument();
    expect(screen.getByText("Available Balance: 10 Credits")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox"), "empty");
    expect(screen.getByText("Available Balance: 0 Credits")).toBeInTheDocument();
  });

  it("shows the banner only in the expiring scenario, and brings it back after a scenario change", async () => {
    render(<BillingMockupPage />);
    expect(screen.queryByText(/credits expire/)).toBeNull();
    await userEvent.selectOptions(screen.getByRole("combobox"), "expiring");
    expect(screen.getByText(/Your Pro Plan credits expire in 3 days \(2026-10-23\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/credits expire/)).toBeNull();
    await userEvent.selectOptions(screen.getByRole("combobox"), "healthy");
    await userEvent.selectOptions(screen.getByRole("combobox"), "expiring");
    expect(screen.getByText(/credits expire/)).toBeInTheDocument();
  });
});

describe("the dev route in App", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    window.history.pushState({}, "", "/");
  });

  async function loadApp() {
    vi.resetModules();
    vi.doMock("../../lib/supabase", () => ({ supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: null } }), mfa: {} } } }));
    vi.doMock("../../context/AuthContext", () => ({ AuthProvider: ({ children }: { children: unknown }) => <>{children}</>, useAuth: () => ({ session: null, loading: false }) }));
    vi.doMock("../../components/CookieConsent", () => ({ CookieConsent: () => null }));
    vi.doMock("../Landing", () => ({ Landing: () => <p>landing page</p> }));
    return (await import("../../App")).default;
  }

  it("renders the mockup at /dev/billing-mockup when running the dev server", async () => {
    window.history.pushState({}, "", "/dev/billing-mockup");
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByText("Dashboard (mockup)")).toBeInTheDocument();
  });

  it("has no such route when not in DEV", async () => {
    vi.stubEnv("DEV", false);
    window.history.pushState({}, "", "/dev/billing-mockup");
    const App = await loadApp();
    render(<App />);
    expect(screen.queryByText("Dashboard (mockup)")).toBeNull();
    expect(await screen.findByText("landing page")).toBeInTheDocument();
  });
});
