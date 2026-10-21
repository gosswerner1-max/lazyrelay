import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/api", () => ({}));
import { CalendarWorkspacePreview } from "./CalendarWorkspacePreview";

beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("CalendarWorkspacePreview (dev only)", () => {
  it("renders made-up posts and only reports what the Google button would do", async () => {
    render(<CalendarWorkspacePreview />);
    expect(screen.getAllByTestId(/^cw-card-/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /click to connect api/i }));
    expect(await screen.findByText(/would start the google calendar connection/i)).toBeInTheDocument();
  });
});
