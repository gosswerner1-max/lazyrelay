// How a failure of a customer's own X app (platform key "x_byok") is classified, and that no other platform's
// classification moved.

import { describe, it, expect } from "vitest";
import { classifyPostError, X_BYOK_CREDIT_MESSAGE, X_BYOK_INVALID_KEYS_MESSAGE, X_BYOK_PERMISSION_MESSAGE } from "./postErrors.js";
import { X_BUNDLE_INVALID_CODE, X_NOT_BYOK_MESSAGE } from "./platforms/xByok.js";

const line = (status: number, title: string, detail = "", type = "") =>
  `x_api_error status=${status}${type ? ` type=${type}` : ""} title="${title}"${detail ? ` detail="${detail}"` : ""}`;

describe("x_byok", () => {
  it("empty wallet or spending limit is fatal with out_of_credit, whichever status X uses", () => {
    const cases = [
      line(402, "CreditsDepleted", "Your enrolled account does not have any credits to fulfill this request."),
      line(402, "Payment Required"),
      line(403, "Forbidden", "Your account has hit its spending limit for this billing cycle"),
      line(429, "UsageCapped", "Usage cap exceeded: Monthly product cap", "https://api.x.com/2/problems/usage-capped"),
      line(429, "Too Many Requests", "You have run out of credits"),
      `media initialize: ${line(402, "CreditsDepleted")}`,
    ];
    for (const raw of cases) {
      expect(classifyPostError("x_byok", raw)).toEqual({ kind: "fatal", message: X_BYOK_CREDIT_MESSAGE, byokStatus: "out_of_credit" });
    }
  });

  it("dead keys are a reconnect with status invalid", () => {
    const cases = [line(401, "Unauthorized", "Unauthorized"), line(401, "code 89", "Invalid or expired token."), line(403, "code 32", "Could not authenticate you."), `media append: ${line(401, "Unauthorized")}`, "Your app has been suspended"];
    for (const raw of cases) {
      expect(classifyPostError("x_byok", raw)).toEqual({ kind: "reconnect", message: X_BYOK_INVALID_KEYS_MESSAGE, byokStatus: "invalid" });
    }
  });

  it("an app without write permission is fatal with the Read and Write advice", () => {
    const cases = [
      line(403, "Forbidden", "Your client app is not configured with the appropriate oauth1 app permissions for this endpoint.", "https://api.x.com/2/problems/oauth1-permissions"),
      line(403, "Client Forbidden", "", "https://api.x.com/2/problems/client-forbidden"),
      line(403, "code 261", "Application cannot perform write actions."),
    ];
    for (const raw of cases) {
      expect(classifyPostError("x_byok", raw)).toEqual({ kind: "fatal", message: X_BYOK_PERMISSION_MESSAGE });
    }
  });

  it("a plain rate limit is a retry, with X's reset time when it sent one", () => {
    expect(classifyPostError("x_byok", line(429, "Too Many Requests", "Too Many Requests"))).toMatchObject({ kind: "retry" });
    const withReset = classifyPostError("x_byok", `${line(429, "Too Many Requests")} reset=1893456000`);
    expect(withReset.kind).toBe("retry");
    expect(withReset.retryNotBefore).toBe(1893456000 * 1000);
    expect(classifyPostError("x_byok", line(429, "Too Many Requests")).retryNotBefore).toBeUndefined();
  });

  it("a missing or damaged key bundle, on either X key, is the fixed reconnect reason", () => {
    for (const platform of ["x", "x_byok"]) {
      expect(classifyPostError(platform, X_BUNDLE_INVALID_CODE)).toMatchObject({ kind: "reconnect", message: X_NOT_BYOK_MESSAGE });
    }
  });

  it("everything X says that is not about the keys falls through to the shared rules", () => {
    expect(classifyPostError("x_byok", line(403, "Forbidden", "You are not allowed to create a Tweet with duplicate content.")).kind).toBe("fatal");
    expect(classifyPostError("x_byok", line(400, "Invalid Request", "The text is too long")).kind).toBe("fatal");
    expect(classifyPostError("x_byok", line(503, "Service Unavailable")).kind).toBe("retry");
    expect(classifyPostError("x_byok", "something nobody has seen")).toEqual({ kind: "retry", message: "something nobody has seen" });
  });

  it("is never 'ours': LazyRelay has no X app to blame", () => {
    expect(classifyPostError("x_byok", "invalid_client app secret").kind).not.toBe("ours");
  });
});

describe("nothing else moved", () => {
  it("the x_byok rules do not apply to any other platform key, including plain x", () => {
    expect(classifyPostError("tiktok", line(402, "CreditsDepleted")).message).not.toBe(X_BYOK_CREDIT_MESSAGE);
    expect(classifyPostError("x", line(401, "Unauthorized")).message).not.toBe(X_BYOK_INVALID_KEYS_MESSAGE);
    expect(classifyPostError("pinterest", line(401, "Unauthorized"))).toMatchObject({ kind: "retry" });
  });
  it("invalid_client is still 'ours' for every other platform", () => {
    expect(classifyPostError("tiktok", "Client key or secret is incorrect.").kind).toBe("ours");
    expect(classifyPostError("linkedin", "invalid_client").kind).toBe("ours");
    expect(classifyPostError("x", "invalid_client").kind).not.toBe("ours"); // LazyRelay has no X app
  });
});
