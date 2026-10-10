// How a failure of a customer's own WhatsApp (Meta) account is classified, from Meta's documented error codes, and that
// no other platform's classification moved. Code lists come from the vault note
// reference-whatsapp-byok-meta-research-2026-10-10 (Meta's official error page). Pure functions, no network.

import { describe, it, expect } from "vitest";
import { classifyPostError, WHATSAPP_BILLING_MESSAGE, WHATSAPP_DEFER_MS, WHATSAPP_INVALID_TOKEN_MESSAGE, type PostErrorKind } from "./postErrors.js";

// The three shapes a Meta code can arrive in.
const shapes = (code: number | string): string[] => [`whatsapp_api_error status=400 code=${code}`, `{"error":{"message":"x","type":"OAuthException","code":${code},"fbtrace_id":"A"}}`, `(#${code}) something`];

function expectKind(code: number | string, kind: PostErrorKind, byokStatus?: "invalid" | "out_of_credit") {
  for (const raw of shapes(code)) {
    const c = classifyPostError("whatsapp", raw);
    expect(c.kind, `${code} as ${raw}`).toBe(kind);
    expect(c.byokStatus, `${code} byokStatus`).toBe(byokStatus);
  }
}

describe("whatsapp: Meta error codes", () => {
  it("reconnect: 0, 10, 190, 200 to 299, 131005, with byok_status invalid and the update-credentials advice", () => {
    for (const code of [0, 10, 190, 200, 210, 250, 299, 131005]) {
      expectKind(code, "reconnect", "invalid");
      expect(classifyPostError("whatsapp", `code=${code}`).message).toBe(WHATSAPP_INVALID_TOKEN_MESSAGE);
    }
  });

  it("retry with backoff: 80007, 130429, 131056, 131016, 131057, 133004, 131000, 132069", () => {
    for (const code of [80007, 130429, 131056, 131016, 131057, 133004, 131000, 132069]) expectKind(code, "retry");
  });

  it("fatal: the documented list, never retried", () => {
    const fatal = [3, 100, 131008, 131009, 131021, 131026, 131031, 368, 131037, 131045, 131047, 131048, 131050, 131051, 131052, 131053, 132000, 132001, 132012, 132016, 132068, 132999, 133010, 134011, 135000];
    for (const code of fatal) expectKind(code, "fatal");
  });

  it("billing 131042 is fatal with byok_status out_of_credit and the billing advice", () => {
    expectKind(131042, "fatal", "out_of_credit");
    expect(classifyPostError("whatsapp", "code=131042").message).toBe(WHATSAPP_BILLING_MESSAGE);
  });

  it("131049 is a retry deferred about 24 hours", () => {
    const before = Date.now();
    const c = classifyPostError("whatsapp", "whatsapp_api_error status=400 code=131049");
    expect(c.kind).toBe("retry");
    expect(c.retryNotBefore).toBeGreaterThanOrEqual(before + WHATSAPP_DEFER_MS);
    expect(c.retryNotBefore).toBeLessThanOrEqual(Date.now() + WHATSAPP_DEFER_MS);
  });

  it("a code is matched whole: 10 is not 100, 3 is not 368 or 30, 0 is not 0123, and a sub code is not a code", () => {
    expect(classifyPostError("whatsapp", "code=100").kind).toBe("fatal"); // not reconnect (10)
    expect(classifyPostError("whatsapp", "code=368").message).toMatch(/restricted/); // its own rule, not generic fatal (3)
    expect(classifyPostError("whatsapp", "code=30").kind).toBe("retry"); // unknown: today's default (retry, raw text)
    expect(classifyPostError("whatsapp", "code=0123").kind).toBe("retry");
    expect(classifyPostError("whatsapp", "code=1,error_subcode=190").kind).not.toBe("reconnect");
  });

  it("never 'ours': no Meta code can blame LazyRelay or count toward a shared breaker", () => {
    const codes = [0, 3, 10, 100, 190, 250, 368, 80007, 130429, 131000, 131005, 131016, 131042, 131047, 131049, 131056, 131057, 132012, 133004, 135000];
    for (const code of codes) expect(classifyPostError("whatsapp", `code=${code}`).kind).not.toBe("ours");
  });

  it("customer-facing text never carries a dash character or the raw Meta body", () => {
    for (const code of [0, 100, 131042, 131047, 131048, 131049, 131050, 131031, 80007, 131016, 132069]) {
      const m = classifyPostError("whatsapp", `{"error":{"message":"SECRET-DETAIL","code":${code}}}`).message;
      expect(m.includes(String.fromCharCode(0x2013)) || m.includes(String.fromCharCode(0x2014))).toBe(false);
      expect(m).not.toContain("SECRET-DETAIL");
    }
  });

  it("the two codes the adapter already reports keep their classification", () => {
    expect(classifyPostError("whatsapp", "whatsapp_byok_bundle_invalid")).toMatchObject({ kind: "reconnect", byokStatus: "invalid" });
    expect(classifyPostError("whatsapp", "whatsapp_send_not_built").kind).toBe("fatal");
  });
});

describe("other platforms are untouched by the WhatsApp rules", () => {
  it("the same Meta codes on facebook classify exactly as before (generic rules)", () => {
    expect(classifyPostError("facebook", '{"error":{"code":190}}').kind).toBe("reconnect");
    expect(classifyPostError("facebook", "code=131042").kind).toBe("retry"); // unknown to the generic rules: default
    expect(classifyPostError("facebook", "code=131042").byokStatus).toBeUndefined();
    expect(classifyPostError("instagram", "code=131047").kind).toBe("retry");
    expect(classifyPostError("tiktok", "code=0").kind).toBe("retry");
  });
});
