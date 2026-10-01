import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FirstCommentDelaySelect } from "./FirstCommentDelaySelect";

afterEach(cleanup);

describe("FirstCommentDelaySelect", () => {
  it("is hidden until a first comment is typed", () => {
    const { container } = render(<FirstCommentDelaySelect firstComment="" platforms={["instagram"]} value={0} onChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("is hidden when no chosen account can delay a comment", () => {
    const { container } = render(<FirstCommentDelaySelect firstComment="Hi" platforms={["tiktok", "bluesky"]} value={0} onChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the eight choices with Right away selected by default", () => {
    render(<FirstCommentDelaySelect firstComment="Hi" platforms={["facebook"]} value={0} onChange={() => {}} />);
    const select = screen.getByLabelText("Post the comment") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      "Right away",
      "After 5 minutes",
      "After 15 minutes",
      "After 30 minutes",
      "After 1 hour",
      "After 2 hours",
      "After 6 hours",
      "After 24 hours",
    ]);
    expect(select.value).toBe("0");
  });

  it("shows a kept value (an edited draft) and reports a change as a number", async () => {
    const onChange = vi.fn();
    render(<FirstCommentDelaySelect firstComment="Hi" platforms={["instagram", "tiktok"]} value={120} onChange={onChange} />);
    const select = screen.getByLabelText("Post the comment") as HTMLSelectElement;
    expect(select.value).toBe("120");
    await userEvent.selectOptions(select, "30");
    expect(onChange).toHaveBeenLastCalledWith(30);
  });
});
