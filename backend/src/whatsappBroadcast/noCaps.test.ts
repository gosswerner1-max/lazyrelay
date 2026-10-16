// BUSINESS RULE (Werner, final): WhatsApp and X are bring-your-own-key. Customers pay Meta and X directly, so LazyRelay puts NO volume
// cap and NO kill switch of its own on these platforms. The only product restriction is the PLAN GATE (free is refused, paid tiers have
// unmetered use of their own keys), plus the rollout env flags and what Meta itself requires (consent, opt-out, the 24 hour window,
// Meta's message formats, the +1 marketing block, pausing a number when Meta reports a restriction).
//
// This is a source scan: it fails if a cap or kill-switch table, column, function, setting or refusal code comes back into the
// WhatsApp code or its unapplied migrations (0128 to 0131). Comments are stripped first, so a note explaining the rule cannot trip it.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..");
const backend = path.resolve(src, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const tsFiles = [
  ...walk(path.join(src, "whatsappBroadcast")),
  ...walk(path.join(src, "whatsappChat")),
  ...fs.readdirSync(path.join(src, "http/routes")).filter((f) => /^whatsapp.*\.ts$/.test(f)).map((f) => path.join(src, "http/routes", f)),
  path.join(src, "startupConfigCheck.ts"),
  path.join(src, "index.ts"),
  path.join(src, "http/whatsappWebhooks.ts"),
].filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith("testKit.ts"));

const migrations = fs
  .readdirSync(path.join(backend, "supabase/migrations"))
  .filter((f) => /^(0128|0129|0130|0131)_/.test(f))
  .map((f) => path.join(backend, "supabase/migrations", f));

const stripTs = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const stripSql = (t: string) => t.replace(/^\s*--.*$/gm, "");

// Identifiers that only exist to cap volume or to stop sending from OUR side.
const FORBIDDEN = new RegExp(
  [
    "whatsapp_send_controls",
    "kill_switch",
    "killSwitch",
    "killedBy",
    "max_recipients_per_broadcast",
    "max_broadcasts_per_day",
    "max_messages_per_day",
    "maxRecipientsPerBroadcast",
    "maxBroadcastsPerDay",
    "maxMessagesPerDay",
    "cap_recipients",
    "cap_broadcasts",
    "cap_messages",
    "cap_reached",
    "sending_stopped",
    "controls_unavailable",
    "send_disabled",
    "MAX_UPDATE_RECIPIENTS",
    "audience_too_large",
    "loadControls",
    "EffectiveControls",
    "countMessagesAcceptedSince",
    "countBroadcastsSince",
  ].join("|"),
);

describe("no volume caps and no kill switches of our own", () => {
  it("scans a real set of files", () => {
    expect(tsFiles.length).toBeGreaterThan(20);
    expect(migrations).toHaveLength(4);
  });

  it.each(tsFiles.map((f) => [path.relative(src, f), f]))("%s has no cap or kill switch", (_n, f) => {
    const m = stripTs(fs.readFileSync(f, "utf8")).match(FORBIDDEN);
    expect(m?.[0] ?? null).toBeNull();
  });

  it.each(migrations.map((f) => [path.basename(f), f]))("%s creates no cap or kill switch table, column, seed or function", (_n, f) => {
    const m = stripSql(fs.readFileSync(f, "utf8")).match(FORBIDDEN);
    expect(m?.[0] ?? null).toBeNull();
  });

  it("the control table file is gone: what is left is only the Meta-driven pause of a connection", () => {
    expect(fs.existsSync(path.join(src, "whatsappBroadcast/controls.ts"))).toBe(false);
    expect(fs.existsSync(path.join(src, "whatsappBroadcast/connectionPause.ts"))).toBe(true);
    const code = stripTs(fs.readFileSync(path.join(src, "whatsappBroadcast/connectionPause.ts"), "utf8"));
    expect(code).toMatch(/pauseConnection/);
    expect(code).not.toMatch(/whatsapp_send_controls|kill/i);
  });

  it("the only reasons a connection can be paused are Meta's (restriction, quality, credentials, template, policy)", () => {
    const sql = stripSql(fs.readFileSync(migrations.find((f) => f.includes("0130_"))!, "utf8"));
    expect(sql).toMatch(/pause_reason in \('quality', 'restricted', 'credentials', 'template', 'policy'\)/);
    expect(sql).toMatch(/create table if not exists whatsapp_connection_send_state/);
  });

  it("the send-capabilities answer is just { sending } (no 'stopped')", () => {
    const routes = stripTs(fs.readFileSync(path.join(src, "http/routes/whatsappBroadcasts.routes.ts"), "utf8"));
    expect(routes).not.toMatch(/stopped/);
  });
});
