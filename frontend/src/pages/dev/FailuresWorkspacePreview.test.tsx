import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/api", () => ({}));
import { FailuresWorkspacePreview } from "./FailuresWorkspacePreview";

afterEach(cleanup);

describe("FailuresWorkspacePreview (dev only)", () => {
  it("renders made-up failures and only reports what 'Open in Posts' would do", async () => {
    render(<FailuresWorkspacePreview />);
    expect(screen.getByRole("button", { name: "Alpha Brand" })).toBeInTheDocument();
    expect(screen.getAllByTestId("fc-tile").length).toBeGreaterThan(0);
    await userEvent.click(screen.getAllByRole("button", { name: /open in posts/i })[0]);
    expect(await screen.findByText(/would open the failed tab/i)).toBeInTheDocument();
  });
});
