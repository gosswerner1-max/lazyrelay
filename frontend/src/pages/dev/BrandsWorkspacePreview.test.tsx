import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/api", () => ({}));
vi.mock("recharts", async (importOriginal) => {
  const real = await importOriginal<typeof import("recharts")>();
  return { ...real, ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 600, height: 160 }) };
});
import { BrandsWorkspacePreview } from "./BrandsWorkspacePreview";

afterEach(cleanup);

describe("BrandsWorkspacePreview (dev only)", () => {
  it("uses made-up brands and only reports what a save would do", async () => {
    render(<BrandsWorkspacePreview />);
    expect(screen.getByRole("heading", { name: "Alpha Brand" })).toBeInTheDocument();
    expect(screen.getByTestId("bp-card-Beta Brand")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Brand voice"), { target: { value: "hello" } });
    await userEvent.click(screen.getByRole("button", { name: /save voice/i }));
    expect(await screen.findByText(/would save the voice/i)).toBeInTheDocument();
  });
});
