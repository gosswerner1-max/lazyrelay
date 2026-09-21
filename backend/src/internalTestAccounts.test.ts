import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { INTERNAL_TEST_EMAIL_PATTERNS, INTERNAL_TEST_EMAILS_EXACT, isInternalTestAccount } from "./internalTestAccounts.js";

// The backend copy of the internal-test-account list must match the ops
// original (ops/shared/internalTestAccounts.js) exactly. Tests only run
// locally, where ops/ sits next to backend/, so this can read the original.
const require = createRequire(import.meta.url);
const opsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ops/shared/internalTestAccounts.js");
const ops = require(opsPath) as {
  INTERNAL_TEST_EMAIL_PATTERNS: RegExp[];
  INTERNAL_TEST_EMAILS_EXACT: Set<string>;
  isInternalTestAccount: (e: string | null | undefined) => boolean;
};

describe("backend internalTestAccounts stays in sync with ops", () => {
  it("has the same patterns", () => {
    expect(INTERNAL_TEST_EMAIL_PATTERNS.map(String)).toEqual(ops.INTERNAL_TEST_EMAIL_PATTERNS.map(String));
  });

  it("has the same exact-match addresses", () => {
    expect([...INTERNAL_TEST_EMAILS_EXACT].sort()).toEqual([...ops.INTERNAL_TEST_EMAILS_EXACT].sort());
  });

  it.each([
    "a@lazyrelay.invalid",
    "b@example.com",
    "c@mail.example.org",
    "goss.werner.1+anything@gmail.com",
    "lazyrelay+reviewer@gmail.com",
    "eva.someone@gmail.com",
    "delivered+welcometest@resend.dev",
    "",
    null,
  ])("agrees with ops on %s", (email) => {
    expect(isInternalTestAccount(email as string | null)).toBe(ops.isInternalTestAccount(email as string | null));
  });
});
