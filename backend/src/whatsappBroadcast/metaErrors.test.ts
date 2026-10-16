// What a failed WhatsApp send or a failed delivery receipt means, decided from Meta's numeric error code (never its message text).
// The rules: an opt-out is honoured and recorded, a restriction or quality or credential problem pauses the CONNECTION and is
// never retried into, a template problem stops the BROADCAST, only a transient error is retried, and a request that got no answer
// is never retried (the message may have gone out; sending again could message a person twice).

import { describe, it, expect } from "vitest";
import { classifyMetaFailure, MAX_TRANSIENT_RETRIES, retryDelayMs } from "./metaErrors.js";

describe("classifyMetaFailure", () => {
  it("131050 (the person stopped marketing messages) is an opt-out", () => {
    expect(classifyMetaFailure({ httpStatus: 400, code: 131050 })).toEqual({ kind: "opt_out", reason: "recipient_opted_out" });
    expect(classifyMetaFailure({ code: 131050 })).toEqual({ kind: "opt_out", reason: "recipient_opted_out" });
  });

  it.each([
    [368, "policy"],
    [131031, "restricted"],
    [130497, "restricted"],
    [131042, "restricted"],
    [131037, "restricted"],
    [131048, "quality"],
  ] as const)("code %i pauses the connection (%s)", (code, pause) => {
    const a = classifyMetaFailure({ httpStatus: 400, code });
    expect(a.kind).toBe("pause_connection");
    expect(a).toMatchObject({ pause });
  });

  it("a bad or unauthorised token (HTTP 401/403, 190, 10, 200-299) pauses the connection as a credentials problem", () => {
    for (const f of [{ httpStatus: 401 }, { httpStatus: 403 }, { code: 190 }, { code: 10 }, { code: 200 }, { code: 299 }]) {
      expect(classifyMetaFailure(f)).toMatchObject({ kind: "pause_connection", pause: "credentials" });
    }
  });

  it.each([132000, 132001, 132005, 132007, 132012, 132015, 132016])("template error %i stops the broadcast instead of failing every recipient one by one", (code) => {
    expect(classifyMetaFailure({ httpStatus: 400, code })).toEqual({ kind: "pause_broadcast", reason: "template_unusable" });
  });

  it("only transient errors are retried: 5xx with an answer, 429, and the temporary and throughput codes", () => {
    for (const f of [{ httpStatus: 500 }, { httpStatus: 503 }, { httpStatus: 429 }, { code: 1 }, { code: 2 }, { code: 130429 }, { code: 131016 }, { code: 80007 }]) {
      expect(classifyMetaFailure(f).kind).toBe("retry");
    }
  });

  it("an ordinary rejection (undeliverable, bad parameter, pair rate limit) fails that recipient and is not retried", () => {
    for (const code of [131026, 131030, 131047, 131051, 131056, 100, 131049]) {
      const a = classifyMetaFailure({ httpStatus: 400, code });
      expect(a.kind).toBe("recipient_failed");
      expect((a as { reason: string }).reason).toMatch(/^[a-z0-9_]{1,60}$/);
    }
  });

  it("no answer at all is NOT retried: the message may have been sent", () => {
    expect(classifyMetaFailure({ noResponse: true })).toEqual({ kind: "recipient_failed", reason: "unconfirmed_no_response" });
  });

  it("restriction codes win over transient-looking HTTP statuses (never retry into a restriction)", () => {
    expect(classifyMetaFailure({ httpStatus: 500, code: 131048 }).kind).toBe("pause_connection");
    expect(classifyMetaFailure({ httpStatus: 503, code: 131050 }).kind).toBe("opt_out");
  });

  it("never returns Meta's text, only codes of ours", () => {
    const a = classifyMetaFailure({ httpStatus: 400, code: 999999 });
    expect(a).toEqual({ kind: "recipient_failed", reason: "meta_error_999999" });
  });
});

describe("retry policy", () => {
  it("at most 3 retries, with a growing delay", () => {
    expect(MAX_TRANSIENT_RETRIES).toBe(3);
    expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(2));
    expect(retryDelayMs(2)).toBeLessThan(retryDelayMs(3));
  });
});
