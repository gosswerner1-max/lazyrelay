import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ByokGuide } from "./ByokGuide";
import { WHATSAPP_GUIDE, X_GUIDE } from "../../lib/byokGuides";

// The in-app setup guides for a customer's OWN Meta (WhatsApp) and X developer credentials. Every step was checked against Meta's and
// X's current official documentation on 2026-10-16 (sources: docs/whatsapp-phase2-pr-notes.md); a step that could not be confirmed
// says plainly to check the current screen. Plain words, one action per step, no dashes.

afterEach(cleanup);

const text = (g: typeof WHATSAPP_GUIDE) => [g.title, g.intro, g.footer, ...g.steps.flatMap((s) => [s.title, s.action, s.note ?? ""])].join("\n");

describe("the guide component", () => {
  it("is a collapsible block, closed until opened, with numbered steps", async () => {
    const user = userEvent.setup();
    const { container } = render(<ByokGuide guide={WHATSAPP_GUIDE} />);
    const details = container.querySelector("details")!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(screen.getByText(WHATSAPP_GUIDE.title)).toBeInTheDocument();
    await user.click(screen.getByText(WHATSAPP_GUIDE.title));
    expect(details.open).toBe(true);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(WHATSAPP_GUIDE.steps.length);
  });

  it("every step has a title and one short action, and links open safely in a new tab", async () => {
    const { container } = render(<ByokGuide guide={WHATSAPP_GUIDE} defaultOpen />);
    for (const s of WHATSAPP_GUIDE.steps) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.action.length).toBeGreaterThan(10);
      expect(s.action.length).toBeLessThan(420);
      expect(screen.getByText(s.title)).toBeInTheDocument();
    }
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
      expect(a.getAttribute("href")).toMatch(/^https:\/\//);
    }
  });
});

describe("WhatsApp guide: each confirmed step is present", () => {
  const body = text(WHATSAPP_GUIDE);
  it.each([
    ["a Meta developer account", /developer account/i],
    ["the developer registration page", /registration/i],
    ["creating an app with the WhatsApp use case", /Connect with customers through WhatsApp/],
    ["a business portfolio", /business portfolio/i],
    ["linking the WhatsApp Business account and phone number", /Start using the API/],
    ["where to copy the two ids", /phone number ID/i],
    ["a system user in Business Settings", /System users/],
    ["assigning the app with Manage app", /Manage app/],
    ["assigning the WhatsApp account", /Manage WhatsApp Business accounts/],
    ["the three token permissions", /business_management[\s\S]*whatsapp_business_management[\s\S]*whatsapp_business_messaging/],
    ["pasting into LazyRelay", /Custom developer keys/],
    ["the three fields LazyRelay asks for", /WABA ID[\s\S]*Phone number ID[\s\S]*System user token/],
    ["replies and delivery receipts via the existing webhook details", /Webhook details for your Meta app/],
    ["the step that makes the Meta app Live", /Make your Meta app Live/],
    ["why Live is needed (test messages only until then)", /Meta only sends test messages from its own dashboard/],
  ])("has %s", (_l, re) => {
    expect(body).toMatch(re);
  });

  it("puts the Live step before the webhook step, because replies cannot arrive until the app is Live", () => {
    const titles = WHATSAPP_GUIDE.steps.map((s) => s.title);
    const live = titles.findIndex((t) => /Make your Meta app Live/.test(t));
    const webhook = titles.findIndex((t) => /Turn on replies and delivery receipts/.test(t));
    expect(live).toBeGreaterThan(-1);
    expect(live).toBeLessThan(webhook);
  });

  it("marks the Live step 'check Meta's current screen' because Meta's screen names can differ", () => {
    expect(WHATSAPP_GUIDE.steps.find((s) => /Make your Meta app Live/.test(s.title))?.note).toMatch(/Check Meta's current screen/);
  });

  it("marks what could not be confirmed as 'check Meta's current screen' (the token expiry and the account name)", () => {
    const notes = WHATSAPP_GUIDE.steps.map((s) => s.note ?? "").join("\n");
    expect(notes).toMatch(/Check Meta's current screen/);
    expect(WHATSAPP_GUIDE.steps.find((s) => /token/i.test(s.title))?.note).toMatch(/expiry/i);
  });

  it("says Meta bills the customer directly, in the words the product already uses, and promises nothing more", () => {
    expect(WHATSAPP_GUIDE.intro).toContain("Meta bills your own WhatsApp Business Account directly. LazyRelay never pays for it.");
    expect(body).not.toMatch(/never expire|free forever|guarantee/i);
  });
});

describe("X guide: each confirmed step is present", () => {
  const body = text(X_GUIDE);
  it.each([
    ["the developer console", /console\.x\.com/],
    ["creating an app with a name, description and use case", /Create App[\s\S]*name[\s\S]*description[\s\S]*use case/i],
    ["Read and write permission", /Read and write/],
    ["setting permissions before generating tokens", /new tokens/i],
    ["the API Key and Secret", /API Key and Secret/],
    ["the Access Token and Secret", /Access Token and Secret/],
    ["that X shows them only once", /only once/i],
    ["the four fields LazyRelay asks for", /API Key \(Consumer Key\)[\s\S]*API Secret \(Consumer Secret\)[\s\S]*Access Token[\s\S]*Access Token Secret/],
  ])("has %s", (_l, re) => {
    expect(body).toMatch(re);
  });

  it("marks account sign-up and projects as 'check X's current screen' because the docs do not describe them", () => {
    expect(X_GUIDE.steps.map((s) => s.note ?? "").join("\n")).toMatch(/Check X's current screen/);
  });

  it("uses the product's existing billing wording", () => {
    expect(X_GUIDE.intro).toContain("X bills your own developer account for every post. LazyRelay never pays for it.");
  });

  it("renders", () => {
    render(<ByokGuide guide={X_GUIDE} defaultOpen />);
    expect(screen.getByText(X_GUIDE.title)).toBeInTheDocument();
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(X_GUIDE.steps.length);
  });
});

describe("wording rules for both guides", () => {
  it.each([["WhatsApp", WHATSAPP_GUIDE], ["X", X_GUIDE]])("%s guide has no em dash or en dash", (_n, g) => {
    expect(text(g)).not.toMatch(/[–—]/);
  });
  it.each([["WhatsApp", WHATSAPP_GUIDE], ["X", X_GUIDE]])("%s guide never shows a real-looking secret", (_n, g) => {
    expect(text(g)).not.toMatch(/EAA[A-Za-z0-9]{10,}|[A-Za-z0-9]{40,}/);
  });
});
