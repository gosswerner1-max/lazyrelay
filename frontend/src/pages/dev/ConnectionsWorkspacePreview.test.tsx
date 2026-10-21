import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/api", () => ({}));
import { ConnectionsWorkspacePreview } from "./ConnectionsWorkspacePreview";

afterEach(cleanup);

describe("ConnectionsWorkspacePreview (dev only)", () => {
  it("uses made-up brands and only reports what a press would do", async () => {
    render(<ConnectionsWorkspacePreview />);
    expect(screen.getByRole("radio", { name: "Alpha Brand" })).toBeInTheDocument();
    expect(screen.getAllByTestId(/^cn-tile-/)).toHaveLength(19);
    await userEvent.click(screen.getByTestId("cn-tile-youtube"));
    expect(await screen.findByText(/would open the social platforms tab/i)).toBeInTheDocument();
  });
});
