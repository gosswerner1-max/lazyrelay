import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// Extra internal addresses (family members' mailboxes) come from the INTERNAL_TEST_EMAILS_EXTRA setting, never from
// source code, so they are not published in the repo. The tests use made-up ones.
vi.hoisted(() => {
  process.env.INTERNAL_TEST_EMAILS_EXTRA = "family.member@example.test, Other.Person@Gmail.com";
  // The ops copy also reads the gitignored local file on this machine, which holds the real family mailboxes. Point it at a
  // file that does not exist so both copies see only the made-up addresses above (same result on any machine and in CI).
  process.env.INTERNAL_TEST_ACCOUNTS_FILE = "does-not-exist.local.json";
});
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

  it("reads extra internal addresses from INTERNAL_TEST_EMAILS_EXTRA (case-insensitive, trimmed, gmail aliases handled)", () => {
    expect(isInternalTestAccount("family.member@example.test")).toBe(true);
    expect(isInternalTestAccount("OTHER.PERSON@gmail.com")).toBe(true);
    expect(isInternalTestAccount("other.person+anything@gmail.com")).toBe(true);
    expect(INTERNAL_TEST_EMAILS_EXACT.has("other.person@gmail.com")).toBe(true);
    expect(isInternalTestAccount("someone.else@gmail.com")).toBe(false);
  });

  it("no personal mailbox of a family member is written in either source file", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const f of [path.join(here, "internalTestAccounts.ts"), opsPath]) {
      const allowed = new Set(["goss.werner.1@gmail.com", "lazyrelay+reviewer@gmail.com", "lazyrelay@gmail.com"]);
      // only quoted strings count: comments may show example addresses, the hardcoded list is made of strings
      const strings = [...fs.readFileSync(f, "utf8").matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2].toLowerCase());
      const found = strings.flatMap((s) => s.match(/[a-z0-9._+-]+@(?:gmail|googlemail|outlook|hotmail|yahoo|icloud|proton)\.[a-z.]+/g) ?? []);
      expect(found.filter((e) => !allowed.has(e)), f).toEqual([]);
    }
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
