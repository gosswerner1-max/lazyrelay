// Final audit guard for the two bring-your-own-key platforms (X own developer keys, WhatsApp own Meta token).
//
// The notice shown before connecting says: "LazyRelay does not control, limit, or throttle usage on these external platforms."
// This file keeps that sentence true. It does three things:
//   1. X and WhatsApp have no rolling post or message cap in the shared posting limits (platformPostLimits.ts).
//   2. Every numeric limit constant in the X and WhatsApp code is on a FIXED, classified list. A new one fails this test until
//      someone classifies it, so a cap cannot slip back in unnoticed:
//        a = a Meta or X protocol rule (a length, a button count, a phone number shape, a retry policy for Meta's transient errors)
//        b = LazyRelay's own HTTP abuse limiting (rateLimit.ts style: per-minute request counts, request size, failed key guessing)
//        e = a format or input bound that is not a volume limit (field lengths, schedule window, worker batch sizes, paging)
//        k = the one cost guard that is kept on purpose and reported to Werner (see KEPT below)
//      (c, the plan limits such as connected-account slots, live in accountLimits.ts and are not touched here.)
//   3. The silent per-delivery drops that used to sit in the webhook readers are gone.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRolling24hPostLimit, PLATFORM_ROLLING_24H_POST_LIMIT } from "./platformPostLimits.js";

const src = path.dirname(fileURLToPath(import.meta.url));

describe("shared posting limits", () => {
  it("X and WhatsApp have no rolling 24 hour cap of LazyRelay's own", () => {
    expect(getRolling24hPostLimit("x")).toBeNull();
    expect(getRolling24hPostLimit("whatsapp")).toBeNull();
    expect(Object.keys(PLATFORM_ROLLING_24H_POST_LIMIT).sort()).toEqual(["instagram", "pinterest"]);
  });
});

function list(dir: string, re: RegExp): string[] {
  return fs
    .readdirSync(path.join(src, dir))
    .filter((f) => re.test(f) && !f.endsWith(".test.ts") && !/testKit|TestKit/.test(f))
    .map((f) => path.join(src, dir, f));
}

const files = [
  ...list("whatsappBroadcast", /\.ts$/),
  ...list("whatsappChat", /\.ts$/),
  ...list("platforms/whatsapp", /\.ts$/),
  ...list("platforms", /^x[A-Za-z]*\.ts$/),
  ...list("http/routes", /^(whatsapp.*|xByok.*)\.ts$/),
  path.join(src, "http/whatsappWebhooks.ts"),
  path.join(src, "whatsappContacts.ts"),
];

const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const LIMIT_NAME = /(MAX|MIN|LIMIT|CAP|PER_|DAILY|RATE|BATCH|RETRIES|RETRY|LEAD|PAGES)/;

function discover(): string[] {
  const found = new Set<string>();
  for (const f of files) {
    for (const m of stripComments(fs.readFileSync(f, "utf8")).matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*([^\n]+)$/gm)) {
      if (LIMIT_NAME.test(m[1]) && /[0-9]/.test(m[2]) && !/^(new |\/|"|')/.test(m[2].trim())) found.add(m[1]);
    }
  }
  return [...found].sort();
}

/** Every limit constant that exists, and what kind it is. */
const CLASSIFIED: Record<string, "a" | "b" | "e" | "k"> = {
  // Meta and X protocol rules
  MAX_TEMPLATE_PARAM_CHARS: "a",
  MAX_TEXT_CHARS: "a",
  MAX_BUTTON_BODY_CHARS: "a",
  MAX_BODY_CHARS: "a",
  MAX_VARIABLES: "a",
  MAX_APPROVAL_OPTIONS: "a",
  MAX_OPTION_TITLE: "a",
  MAX_OPTION_ID: "a",
  MAX_APPROVAL_BODY: "a",
  MAX_APPROVAL_TITLE: "a",
  MAX_TEXT: "a",
  MAX_STORED_TEXT_CHARS: "a",
  PHONE_MIN_DIGITS: "a",
  PHONE_MAX_DIGITS: "a",
  MAX_TRANSIENT_RETRIES: "a",
  RETRY_DELAYS_MS: "a",
  // LazyRelay's own HTTP abuse limiting
  WHATSAPP_WEBHOOK_MAX_BYTES: "b",
  WHATSAPP_WEBHOOK_PER_IP_PER_MINUTE: "b",
  WHATSAPP_WEBHOOK_GLOBAL_PER_MINUTE: "b",
  MAX_CHALLENGE_LENGTH: "b",
  MAX_IMPORT_ROWS: "b",
  RATE_WINDOW_MS: "b",
  RATE_MAX: "b",
  REMOVE_RATE_MAX: "b",
  X_BYOK_FAILED_VALIDATIONS_PER_DAY: "b",
  WHATSAPP_BYOK_FAILED_VALIDATIONS_PER_DAY: "b",
  // Formats, windows, paging and worker batch sizes: none of them is a volume limit
  MIN_LEAD_MS: "e",
  MAX_LEAD_MS: "e",
  MAX_TEMPLATE_PAGES: "e",
  DEFAULT_BATCH_SIZE: "e",
  HAND_OFF_LIMIT: "e",
  SENDING_LIMIT: "e",
  MAX_NAME: "e",
  MAX_NAME_CHARS: "e",
  MAX_NAME_LENGTH: "e",
  MAX_TRIAGE_TEXT_CHARS: "e",
  MAX_FIELD: "e",
  MIN_KEY_LENGTH: "e",
  WHATSAPP_TOKEN_MIN_LENGTH: "e",
  WHATSAPP_TOKEN_MAX_LENGTH: "e",
  WHATSAPP_APP_SECRET_MIN_LENGTH: "e",
  WHATSAPP_APP_SECRET_MAX_LENGTH: "e",
  OPT_OUT_MAX_LENGTH: "e",
  X_KEY_MIN_LENGTH: "e",
  X_KEY_MAX_LENGTH: "e",
  // KEPT on purpose, reported to Werner: LazyRelay's own AI bill, not use of WhatsApp.
  WHATSAPP_TRIAGE_DAILY_CAP: "k",
};

describe("every remaining limit constant is classified", () => {
  it("scans a real set of files", () => {
    expect(files.length).toBeGreaterThan(35);
  });

  it("the discovered limit constants are exactly the classified list (a new one must be classified here first)", () => {
    expect(discover()).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it("the only kept cost guard is the AI triage allowance, which is off unless its own env flag is on and never stops a message being stored or sent", () => {
    expect(Object.entries(CLASSIFIED).filter(([, c]) => c === "k").map(([n]) => n)).toEqual(["WHATSAPP_TRIAGE_DAILY_CAP"]);
    const code = stripComments(fs.readFileSync(path.join(src, "http/whatsappWebhooks.ts"), "utf8"));
    expect(code).toMatch(/triageEnabled\(\) \? reserveTriageSlots/);
    // the rows are written BEFORE the allowance is looked at, so no message is ever refused because of it
    expect(code.indexOf('.from("whatsapp_messages")')).toBeLessThan(code.indexOf("reserveTriageSlots(account.account_id"));
  });
});

describe("no webhook reader silently drops what Meta sent", () => {
  it("the per-delivery caps (200 messages, 1,000 receipts) are gone from all three readers", () => {
    for (const f of ["http/whatsappWebhooks.ts", "whatsappChat/inbound.ts", "whatsappBroadcast/statusWebhook.ts"]) {
      const code = stripComments(fs.readFileSync(path.join(src, f), "utf8"));
      expect(code, f).not.toMatch(/MAX_MESSAGES_PER_DELIVERY|MAX_PER_DELIVERY|MAX_RECEIPTS_PER_DELIVERY/);
    }
  });
});

describe("X and WhatsApp code holds no per-day or per-month volume rule, quota or throttle", () => {
  const ALLOWED_DAILY = new Set(["X_BYOK_FAILED_VALIDATIONS_PER_DAY", "WHATSAPP_BYOK_FAILED_VALIDATIONS_PER_DAY", "WHATSAPP_TRIAGE_DAILY_CAP"]);
  it.each(files.map((f) => [path.relative(src, f), f]))("%s", (_n, f) => {
    const code = stripComments(fs.readFileSync(f, "utf8"));
    const hits = [...code.matchAll(/\b([A-Za-z_]*(?:DAILY|PER_DAY|PER_MONTH|MONTHLY|QUOTA|THROTTLE|perDay|dailyLimit|monthlyLimit)[A-Za-z_]*)\b/g)].map((m) => m[1]).filter((n) => !ALLOWED_DAILY.has(n));
    expect(hits).toEqual([]);
  });
});
