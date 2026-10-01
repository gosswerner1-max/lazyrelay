import { describe, expect, it } from "vitest";

// Every CodeBlock that shows a real generated secret (MFA recovery codes, the
// TOTP secret, a webhook secret, a newly created API key) must pass `sensitive`,
// which adds PostHog's ph-mask class so session replay cannot record it. A
// fifth reveal (regenerated recovery codes) once missed the flag, so this scans
// the source instead of trusting each call site to remember.
const sources = import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const SECRET_WORDS = /mfaRecoveryCodes|mfaEnrollment|recoveryCodes|newlyCreatedKey|\bsecret\b/;

describe("CodeBlock that reveals a real secret", () => {
  it("always passes the sensitive prop", () => {
    const offenders: string[] = [];
    let secretBlocks = 0;
    for (const [file, text] of Object.entries(sources)) {
      for (const match of text.matchAll(/<CodeBlock\b[\s\S]*?\/>/g)) {
        // Only identifiers count: words inside quoted text are docs examples, not real secrets.
        const withoutQuotedText = match[0].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
        if (!SECRET_WORDS.test(withoutQuotedText)) continue;
        secretBlocks += 1;
        if (!/\bsensitive\b/.test(match[0])) {
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(`${file.replace("../", "")}:${line}`);
        }
      }
    }
    expect(secretBlocks).toBeGreaterThanOrEqual(5); // the scan really found the secret reveals
    expect(offenders).toEqual([]);
  });
});
