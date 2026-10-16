// The two switches, both OFF unless the environment says exactly "true". Sending needs both, and the generic
// "WhatsApp can send a post" switch (whatsappSendingSupported) must NOT follow them: it would open every generic path
// (public API key, MCP, Zapier, bulk, duplicate), which have no business creating a broadcast.

import { describe, it, expect, afterEach } from "vitest";
import { broadcastsEnabled, sendEnabled, BROADCASTS_FLAG, SEND_FLAG } from "./flags.js";
import { whatsappSendingSupported, isWhatsappSendBlocked } from "../platforms/whatsapp/sendSupport.js";

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe("flags", () => {
  it("names", () => {
    expect(BROADCASTS_FLAG).toBe("WHATSAPP_BROADCASTS_ENABLED");
    expect(SEND_FLAG).toBe("WHATSAPP_SEND_ENABLED");
  });

  it("everything is off by default", () => {
    delete process.env.WHATSAPP_BYOK_ENABLED;
    delete process.env.WHATSAPP_BROADCASTS_ENABLED;
    delete process.env.WHATSAPP_SEND_ENABLED;
    expect(broadcastsEnabled()).toBe(false);
    expect(sendEnabled()).toBe(false);
  });

  it("only the exact string 'true' counts", () => {
    process.env.WHATSAPP_BYOK_ENABLED = "true";
    for (const v of ["1", "TRUE", "True", "yes", "on", " true", "true "]) {
      process.env.WHATSAPP_BROADCASTS_ENABLED = v;
      process.env.WHATSAPP_SEND_ENABLED = v;
      expect(broadcastsEnabled()).toBe(false);
      expect(sendEnabled()).toBe(false);
    }
  });

  it("sending needs the feature on (BYOK + broadcasts) AND the send flag", () => {
    process.env.WHATSAPP_BYOK_ENABLED = "true";
    process.env.WHATSAPP_BROADCASTS_ENABLED = "true";
    expect(broadcastsEnabled()).toBe(true);
    expect(sendEnabled()).toBe(false);
    process.env.WHATSAPP_SEND_ENABLED = "true";
    expect(sendEnabled()).toBe(true);
    process.env.WHATSAPP_BROADCASTS_ENABLED = "false";
    expect(sendEnabled()).toBe(false);
    process.env.WHATSAPP_BROADCASTS_ENABLED = "true";
    process.env.WHATSAPP_BYOK_ENABLED = "false";
    expect(sendEnabled()).toBe(false);
  });

  it("whatsappSendingSupported() does NOT follow the flags: the generic post path stays closed", () => {
    process.env.WHATSAPP_BYOK_ENABLED = "true";
    process.env.WHATSAPP_BROADCASTS_ENABLED = "true";
    process.env.WHATSAPP_SEND_ENABLED = "true";
    expect(whatsappSendingSupported()).toBe(false);
    expect(isWhatsappSendBlocked("whatsapp")).toBe(true);
  });
});
