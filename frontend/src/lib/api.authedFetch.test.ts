import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// authedFetch is the one authenticated call helper. The Content Sources session call needs to tell a 404 (feature switched
// off) from a 401 (sign in again) from a 503 (try later), so a failed call carries the HTTP status as well as the message.

vi.mock("./supabase", () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "jwt-test" } } })) } },
}));

import { authedFetch } from "./api";

type Failure = Error & { status?: number; code?: string };

function answer(status: number, body: unknown) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body === null ? null : JSON.stringify(body), { status }));
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("authedFetch failures", () => {
  it("carries the HTTP status on a failed call", async () => {
    answer(404, {});
    const err = (await authedFetch("/x").catch((e: unknown) => e)) as Failure;
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Request failed: 404");
  });

  it("keeps the message and the code the server sent, and still adds the status", async () => {
    answer(409, { error: "Nope", code: "some_code" });
    const err = (await authedFetch("/x").catch((e: unknown) => e)) as Failure;
    expect(err.message).toBe("Nope");
    expect(err.code).toBe("some_code");
    expect(err.status).toBe(409);
  });

  it("still returns the body on success and null on 204", async () => {
    answer(200, { a: 1 });
    expect(await authedFetch("/x")).toEqual({ a: 1 });
    answer(204, null);
    expect(await authedFetch("/x")).toBeNull();
  });
});
