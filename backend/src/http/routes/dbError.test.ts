import { describe, expect, it, vi } from "vitest";
import { dbError } from "./shared.js";

function fakeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("dbError", () => {
  it("answers 404 when the id is not a valid UUID", () => {
    const res = fakeRes();
    dbError(res as never, { message: 'invalid input syntax for type uuid: "does-not-exist"' }, "test");
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Not found" });
  });

  it("still answers 500 with a generic message for a real database fault", () => {
    const res = fakeRes();
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbError(res as never, { message: 'duplicate key value violates unique constraint "x"' }, "test");
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Something went wrong on our end. Please try again." });
  });
});
