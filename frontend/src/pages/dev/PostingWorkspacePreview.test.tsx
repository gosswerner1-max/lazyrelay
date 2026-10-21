import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/api", () => ({}));
import { PostingWorkspacePreview } from "./PostingWorkspacePreview";

beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("PostingWorkspacePreview (dev only)", () => {
  it("uses made-up brands and only reports what a press would do", async () => {
    render(<PostingWorkspacePreview />);
    expect(screen.getByLabelText(/brand/i)).toHaveValue("Alpha Brand");
    fireEvent.change(screen.getByLabelText(/caption/i), { target: { value: "hello" } });
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(await screen.findByText(/would save a draft/i)).toBeInTheDocument();
  });
});
