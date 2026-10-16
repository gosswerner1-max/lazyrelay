// STRUCTURE checks: there is no public API key, MCP, Zapier, SDK, bulk or duplicate path that can create a broadcast, send or read a
// chat. These read the source as text. The only importers of the sender and chat modules are the signed-in dashboard routes, the
// webhook handler and the boot file; the routes are mounted once; the generic WhatsApp post path stays closed.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { whatsappSendingSupported, isWhatsappSendBlocked } from "../platforms/whatsapp/sendSupport.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "..");
const repoRoot = path.resolve(srcRoot, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(srcRoot, p).replace(/\\/g, "/");
const read = (p: string) => fs.readFileSync(p, "utf8");

describe("who may import the broadcast and chat modules", () => {
  const files = walk(srcRoot).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !rel(f).startsWith("whatsappBroadcast/") && !rel(f).startsWith("whatsappChat/"));
  const importers = files.filter((f) => /from "(\.\.?\/)+whatsapp(Broadcast|Chat)\//.test(read(f))).map(rel).sort();

  it("only the dashboard routes, the webhook handler and the boot file import them", () => {
    expect(importers).toEqual(["http/routes/whatsappBroadcasts.routes.ts", "http/routes/whatsappChat.routes.ts", "http/routes/whatsappRouteGate.ts", "http/whatsappWebhooks.ts", "index.ts"]);
  });

  it("the public API, MCP, bulk, duplicate and posting code never import them", () => {
    for (const f of files) {
      const r = rel(f);
      if (/^(mcp|http\/mcp|http\/routes\/(posts|bulk|apiKeys|publicApi))/.test(r) || /bulk|duplicate/i.test(r)) expect(importers).not.toContain(r);
    }
  });

  it("every route in the two routers is behind the human-only gate (an API key is refused)", () => {
    for (const f of ["http/routes/whatsappBroadcasts.routes.ts", "http/routes/whatsappChat.routes.ts"]) {
      const routes = [...read(path.join(srcRoot, f)).matchAll(/router\.(get|post|put|delete)\(\s*"([^"]+)",\s*([^\n]*)/g)];
      expect(routes.length).toBeGreaterThan(5);
      for (const [, , p, rest] of routes) {
        if (p === "/whatsapp/send-capabilities") continue; // booleans only, behind sign-in
        expect(rest, `${f} ${p}`).toMatch(/^\.\.\.humanRoute/);
      }
    }
  });
});

describe("no other door", () => {
  it("MCP, Zapier, n8n, the SDK, the browser extension and the OpenAPI document never mention these routes", () => {
    const fragment = /whatsapp\/(broadcasts|conversations|approvals|audiences|templates|rate-card|send-capabilities|connections)/;
    const roots = ["backend/src/mcp", "backend/src/http/mcpRoutes.ts", "backend/src/openapi.ts", "zapier-integration", "n8n-nodes-lazyrelay", "sdk", "mcp-server", "browser-extension"];
    for (const r of roots) {
      const p = path.join(repoRoot, r);
      if (!fs.existsSync(p)) continue;
      const list = fs.statSync(p).isDirectory() ? walk(p).filter((f) => /\.(ts|js|json|md)$/.test(f)) : [p];
      for (const f of list) expect(read(f), path.relative(repoRoot, f)).not.toMatch(fragment);
    }
  });

  it("the generic 'post to WhatsApp' path stays closed (whatsappSendingSupported is false)", () => {
    expect(whatsappSendingSupported()).toBe(false);
    expect(isWhatsappSendBlocked("whatsapp")).toBe(true);
  });

  it("the routers are mounted exactly once, in the signed-in API router", () => {
    const routes = read(path.join(srcRoot, "http/routes.ts"));
    expect(routes.match(/buildWhatsAppBroadcastsRouter\(\)/g)).toHaveLength(1);
    expect(routes.match(/buildWhatsAppChatRouter\(\)/g)).toHaveLength(1);
    const app = read(path.join(srcRoot, "http/app.ts"));
    expect(app).not.toMatch(/WhatsAppBroadcastsRouter|WhatsAppChatRouter/);
  });

  it("the boot file runs the sender loop and the retention purge, and nothing sends from anywhere else", () => {
    const index = read(path.join(srcRoot, "index.ts"));
    expect(index).toMatch(/runBroadcastCycle\(/);
    expect(index).toMatch(/purgeWhatsappHistory\(/);
    const senders = walk(srcRoot).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).filter((f) => /sendTemplate\(|sendText\(|sendInteractiveButtons\(|sendInteractiveList\(/.test(read(f))).map(rel).sort();
    expect(senders).toEqual(["whatsappBroadcast/cloudApi.ts", "whatsappBroadcast/sender.ts", "whatsappChat/chatSend.ts"]);
  });
});
