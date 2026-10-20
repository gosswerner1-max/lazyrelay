import { describe, expect, it, vi } from "vitest";
import { CompetitorError } from "./competitorMode";
import {
  ALREADY_CHARGED_MESSAGE,
  IDEMPOTENCY_CONFLICT_MESSAGE,
  IN_FLIGHT_MESSAGE,
  createBillingCompetitorClient,
  insufficientCreditsMessage,
  newIdempotencyKey,
  type BillingFetcher,
} from "./competitorBilling";

const KEY = "11111111-2222-4333-8444-555555555555";
const DASH = /[–—]/;

const engineBlueprint = {
  hook: { type: "statistic", note: "It opens with a number." },
  sections: [{ order: 1, role: "Problem", summary: "Names the pain." }],
  cta: { placement: "bottom", style: "One button", count: 1 },
  adjustments: ["Open with a number too."],
};

const success = {
  blueprint: { ...engineBlueprint, kind: "page", sourceUrl: "https://rival.example/pricing", title: "Rival pricing" },
  chargedCredits: 10,
  balance: 90,
};

type Failure = Error & { status?: number; code?: string; balance?: number; required?: number };
const failure = (status: number | undefined, code?: string, extra: Partial<Failure> = {}) =>
  Object.assign(new Error("raw server text that must never reach a person"), { status, code, ...extra }) as Failure;

const fetcherOf = (impl: BillingFetcher) => vi.fn<BillingFetcher>(impl);
const run = (fetcher: BillingFetcher, signal?: AbortSignal) => createBillingCompetitorClient(fetcher).blueprint("https://rival.example/pricing", signal, KEY);

async function messageOf(err: unknown): Promise<{ code: string; message: string }> {
  expect(err).toBeInstanceOf(CompetitorError);
  const e = err as CompetitorError;
  return { code: e.code, message: e.message };
}
const rejection = async (fetcher: BillingFetcher) => messageOf(await run(fetcher).catch((e: unknown) => e));

describe("the request", () => {
  it("posts the link, the supplied key and the consent flag to the wallet teardown route, with the abort signal", async () => {
    const fetcher = fetcherOf(async () => success);
    const ctl = new AbortController();
    await run(fetcher, ctl.signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/wallet/teardown");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(ctl.signal);
    expect(JSON.parse(String(init?.body))).toEqual({ input: "https://rival.example/pricing", idempotencyKey: KEY, consent: true });
  });

  it("sends the same key again when the caller retries with it, and a different one when the caller supplies a different one", async () => {
    const fetcher = fetcherOf(async () => success);
    const client = createBillingCompetitorClient(fetcher);
    await client.blueprint("https://rival.example/a", undefined, KEY);
    await client.blueprint("https://rival.example/a", undefined, KEY);
    await client.blueprint("https://rival.example/a", undefined, "99999999-2222-4333-8444-555555555555");
    const keys = fetcher.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual([KEY, KEY, "99999999-2222-4333-8444-555555555555"]);
  });

  it("never invents a key: without one it sends nothing", async () => {
    const fetcher = fetcherOf(async () => success);
    const err = await createBillingCompetitorClient(fetcher).blueprint("https://rival.example/a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompetitorError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("mints a v4 style id", () => {
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});

describe("a delivered blueprint", () => {
  it("comes back in the same shape the engine client gives, with the charge and the new balance", async () => {
    const result = await run(fetcherOf(async () => success));
    expect(result).toMatchObject({ kind: "page", sourceUrl: "https://rival.example/pricing", title: "Rival pricing", creditsUsed: 10, balance: 90 });
    expect(result.blueprint.hook).toEqual({ type: "statistic", note: "It opens with a number." });
    expect(result.blueprint.sections).toHaveLength(1);
  });

  it("also reads the whole engine answer when the backend nests it under blueprint", async () => {
    const nested = { blueprint: { kind: "page", sourceUrl: "https://rival.example/x", title: "X", blueprint: engineBlueprint, creditsUsed: 1 }, chargedCredits: 10, balance: 5 };
    const result = await run(fetcherOf(async () => nested));
    expect(result).toMatchObject({ sourceUrl: "https://rival.example/x", creditsUsed: 10, balance: 5 });
  });

  it("leaves the balance out when the backend does not send a number", async () => {
    const result = await run(fetcherOf(async () => ({ ...success, balance: "ninety" })));
    expect(result.balance).toBeUndefined();
  });

  it.each([null, "text", { chargedCredits: 10 }, { blueprint: "x", chargedCredits: 10 }, { ...success, chargedCredits: "ten" }])("calls an unreadable answer a bad answer (%j)", async (body) => {
    const out = await rejection(async () => body);
    expect(out.code).toBe("bad_response");
  });

  it("says a repeated key was already run and charged, and shows no blueprint", async () => {
    const out = await rejection(async () => ({ replay: true, status: "committed" }));
    expect(out.message).toBe("This analysis was already run and charged. Run it again to see it.");
    expect(out.message).toBe(ALREADY_CHARGED_MESSAGE);
  });
});

describe("billing errors", () => {
  it("402 insufficient_credits says how many are needed and how many the person has, with the code kept", async () => {
    const out = await rejection(async () => {
      throw failure(402, "insufficient_credits", { balance: 3, required: 10 });
    });
    expect(out).toEqual({ code: "insufficient_credits", message: "You need 10 credits for a competitor teardown. You have 3." });
    expect(insufficientCreditsMessage(3, 10)).toBe(out.message);
  });

  it("402 without numbers still asks for 10 credits and does not invent a balance", async () => {
    const out = await rejection(async () => {
      throw failure(402, "insufficient_credits");
    });
    expect(out.message).toBe("You need 10 credits for a competitor teardown.");
  });

  it("409 in_flight and 409 idempotency_conflict have their own sentences", async () => {
    const inFlight = await rejection(async () => {
      throw failure(409, "in_flight");
    });
    const conflict = await rejection(async () => {
      throw failure(409, "idempotency_conflict");
    });
    expect(inFlight).toEqual({ code: "in_flight", message: "A teardown is already running. Please wait for it to finish." });
    expect(inFlight.message).toBe(IN_FLIGHT_MESSAGE);
    expect(conflict).toEqual({ code: "idempotency_conflict", message: "That request was already used. Please try again." });
    expect(conflict.message).toBe(IDEMPOTENCY_CONFLICT_MESSAGE);
  });

  it("404 is the plain 'not switched on yet' line", async () => {
    const out = await rejection(async () => {
      throw failure(404);
    });
    expect(out.message).toBe("This feature is not switched on yet.");
  });
});

describe("every engine code keeps its current wording", () => {
  const cases: Array<[string, number, RegExp]> = [
    ["plan_limit", 403, /limit on your plan/],
    ["cooldown", 429, /wait a moment before analyzing/],
    ["daily_limit", 429, /today's limit/],
    ["page_blocked", 422, /does not let us read it/],
    ["reader_timeout", 504, /took too long to read/],
    ["reader_unavailable", 503, /could not read pages right now/],
    ["competitor_mode_unavailable", 503, /not switched on yet/],
    ["blueprint_not_supported", 422, /web pages and posts for now/],
    ["blueprint_invalid", 502, /could not build a blueprint/],
    ["draft_unavailable", 503, /could not build a blueprint/],
    ["invalid_input", 400, /could not use that link/],
    ["invalid_url", 400, /could not use that link/],
  ];
  it.each(cases)("%s", async (code, status, words) => {
    const out = await rejection(async () => {
      throw failure(status, code);
    });
    expect(out.message).toMatch(words);
    expect(out.message).not.toMatch(/raw server text/);
  });

  it("network_not_supported keeps the engine's own short plain sentence, and falls back to the built in one when it is long", async () => {
    const own = await rejection(async () => {
      throw Object.assign(failure(422, "network_not_supported"), { message: "That network is closed to us." });
    });
    expect(own.message).toBe("That network is closed to us.");
    const long = await rejection(async () => {
      throw Object.assign(failure(422, "network_not_supported"), { message: "x".repeat(300) });
    });
    expect(long.message).toMatch(/blocks public reading/);
  });

  it("a sign in problem asks the person to sign in again, never showing the raw text", async () => {
    const signedOut = await rejection(async () => {
      throw new Error("Not signed in");
    });
    expect(signedOut.code).toBe("sign_in");
    const expired = await rejection(async () => {
      throw failure(401);
    });
    expect(expired.code).toBe("sign_in");
  });

  it("an unknown code or a gateway failure is a plain sentence by status", async () => {
    expect((await rejection(async () => { throw failure(500, "weird_thing"); })).code).toBe("unavailable");
    expect((await rejection(async () => { throw failure(429); })).code).toBe("rate_limited");
  });

  it("a dropped connection is the plain network line, and the raw error goes to the console only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await rejection(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(out.code).toBe("network");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("cancelling and timing out", () => {
  it("an aborted request is the plain timeout line", async () => {
    const ctl = new AbortController();
    const fetcher = fetcherOf((_path, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const pending = run(fetcher, ctl.signal).catch((e: unknown) => e);
    ctl.abort();
    const out = await messageOf(await pending);
    expect(out.code).toBe("timeout");
  });
});

describe("the words", () => {
  it("have no em or en dash and none of the claims we cannot prove", () => {
    const all = [ALREADY_CHARGED_MESSAGE, IN_FLIGHT_MESSAGE, IDEMPOTENCY_CONFLICT_MESSAGE, insufficientCreditsMessage(2, 10)].join(" ");
    expect(all).not.toMatch(DASH);
    expect(all).not.toMatch(/\b(free|instant(ly)?|guarantee[ds]?)\b/i);
  });
});
