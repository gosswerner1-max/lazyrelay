import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// BUSINESS RULE (Werner, final): WhatsApp and X are bring-your-own-key. Customers pay Meta and X directly, so LazyRelay shows no volume
// cap, throttle, kill switch or placeholder number on these two platforms. This scan fails if limit wording or a cap-related disabled
// state comes back into the WhatsApp screens, their helpers or the WhatsApp half of the API client. (Meta's own message formats, such as
// three reply buttons, are not LazyRelay limits and are not scanned for.)

const root = resolve(__dirname, "..");
const dashboard = resolve(root, "components/dashboard");
const files = [
  ...readdirSync(dashboard).filter((f) => /^WhatsApp.*\.tsx$/.test(f) && !f.endsWith(".test.tsx")).map((f) => resolve(dashboard, f)),
  resolve(root, "pages/dashboard/WhatsAppTab.tsx"),
  resolve(root, "pages/dashboard/useWhatsAppSend.ts"),
  resolve(root, "lib/whatsappSend.ts"),
];
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const LIMIT_WORDING = /switched off|kill_switch|send_disabled|cap_reached|up to 25|at most \d+|\bstopped\b|daily cap|per day|throttl/i;

describe("no limit, cap or kill-switch wording on the WhatsApp screens", () => {
  it("scans a real set of files", () => expect(files.length).toBeGreaterThan(10));

  it.each(files.map((f) => [f.replace(root, "src"), f]))("%s", (_n, f) => {
    const text = strip(readFileSync(f, "utf8"));
    expect(text.match(LIMIT_WORDING)?.[0] ?? null).toBeNull();
    expect(text).not.toContain("PLACEHOLDER");
  });

  it("the API client's send-capabilities answer is just { sending }", () => {
    const api = readFileSync(resolve(root, "lib/api.ts"), "utf8");
    const line = api.split("\n").find((l) => l.includes("getWhatsAppSendCapabilities"))!;
    expect(line).toContain("{ sending: boolean }");
    expect(line).not.toContain("stopped");
  });
});
