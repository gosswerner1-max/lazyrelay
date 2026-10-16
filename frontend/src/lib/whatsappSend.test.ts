import { describe, it, expect } from "vitest";
import { approvalStatusLabel, broadcastStatusLabel, costLine, deliveryLine, localInputToIso, messageStatusLabel, pauseReasonText, validateBroadcast, windowLabel, COPY } from "./whatsappSend";

// Pure helpers for the WhatsApp broadcast and chat screens. The backend decides everything; these only word what it says and check
// the form before anything is sent. Plain words, no dashes in user-facing text, and nothing that claims more than Meta confirmed.

describe("deliveryLine", () => {
  it("shows only what Meta confirmed: 'N delivered of M, confirmed by Meta'", () => {
    expect(deliveryLine({ delivered: 7, ofAccepted: 10 })).toBe("7 delivered of 10, confirmed by Meta");
    expect(deliveryLine({ delivered: 0, ofAccepted: 3 })).toBe("0 delivered of 3, confirmed by Meta");
  });
  it("says so plainly when nothing has been handed to Meta yet", () => {
    expect(deliveryLine({ delivered: 0, ofAccepted: 0 })).toBe("Nothing has been handed to WhatsApp yet");
  });
});

describe("costLine", () => {
  it("is always labelled an estimate from the customer's own rate card, never a Meta figure", () => {
    expect(costLine({ amount: 0.1, currency: "USD", isEstimate: true })).toBe("Estimated cost: USD 0.10 (from your own rate card, not Meta's bill)");
    expect(costLine({ amount: 0, currency: "ZAR", isEstimate: true })).toBe("Estimated cost: ZAR 0.00 (from your own rate card, not Meta's bill)");
    expect(costLine({ amount: 0.004, currency: "USD", isEstimate: true })).toBe("Estimated cost: USD 0.0040 (from your own rate card, not Meta's bill)");
  });
  it("asks for a rate card instead of guessing", () => {
    expect(costLine(null)).toBe("Add your rate card to see an estimated cost");
  });
});

describe("windowLabel", () => {
  it("says open with the hours left, or closed with what to do", () => {
    expect(windowLabel({ open: true, expiresAt: "2026-10-17T00:00:00.000Z", hoursLeft: 5 })).toBe("Open, 5 hours left");
    expect(windowLabel({ open: true, expiresAt: "x", hoursLeft: 1 })).toBe("Open, 1 hour left");
    expect(windowLabel({ open: false, expiresAt: null, hoursLeft: 0 })).toBe("Closed, template required");
  });
});

describe("labels", () => {
  it("broadcast status", () => {
    expect(["scheduled", "sending", "completed", "cancelled", "paused", "failed"].map((s) => broadcastStatusLabel(s as never))).toEqual(["Scheduled", "Sending", "Finished", "Cancelled", "Paused", "Failed"]);
  });
  it("message status: handed off is NOT delivered", () => {
    expect(messageStatusLabel("handed_off")).toBe("Handed to WhatsApp");
    expect(messageStatusLabel("delivered")).toBe("Delivered");
    expect(messageStatusLabel("read")).toBe("Read");
    expect(messageStatusLabel("failed")).toBe("Not sent");
    expect(messageStatusLabel("received")).toBe("");
  });
  it("approval status, in plain words", () => {
    expect(["pending", "approved", "changes_requested", "question", "other_reply"].map((s) => approvalStatusLabel(s as never))).toEqual(["Waiting for an answer", "Approved", "Changes requested", "Has a question", "Replied another way"]);
  });
  it("pause reasons say what to do", () => {
    for (const r of ["quality", "restricted", "credentials", "template", "policy", "kill_switch", "plan", "cap_reached", "connection_unavailable", "connection_paused", "template_unusable", "send_disabled"]) {
      expect(pauseReasonText(r).length).toBeGreaterThan(10);
    }
    expect(pauseReasonText("something_new")).toMatch(/paused/i);
  });
});

describe("localInputToIso", () => {
  it("turns a datetime-local value into an ISO time, and rejects nonsense", () => {
    expect(localInputToIso("2026-10-20T09:30")).toBe(new Date("2026-10-20T09:30").toISOString());
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("not a date")).toBeNull();
  });
});

describe("validateBroadcast", () => {
  const NOW = new Date("2026-10-16T12:00:00").getTime();
  const ok = { connectionId: "c", templateId: "t", name: "Spring sale", params: ["a", "b"], variableCount: 2, scheduledLocal: "2026-10-17T09:00" };
  it("accepts a complete form", () => {
    expect(validateBroadcast(ok, NOW)).toEqual({});
  });
  it("names every missing or wrong field", () => {
    expect(validateBroadcast({ ...ok, templateId: "" }, NOW).template).toBeTruthy();
    expect(validateBroadcast({ ...ok, name: "  " }, NOW).name).toBeTruthy();
    expect(validateBroadcast({ ...ok, name: "+27 82 123 4567" }, NOW).name).toBeTruthy();
    expect(validateBroadcast({ ...ok, params: ["a"] }, NOW).params).toBeTruthy();
    expect(validateBroadcast({ ...ok, params: ["a", " "] }, NOW).params).toBeTruthy();
    expect(validateBroadcast({ ...ok, scheduledLocal: "" }, NOW).schedule).toBeTruthy();
    expect(validateBroadcast({ ...ok, scheduledLocal: "2026-10-16T12:00" }, NOW).schedule).toBeTruthy();
    expect(validateBroadcast({ ...ok, scheduledLocal: "2026-12-30T09:00" }, NOW).schedule).toBeTruthy();
  });
});

describe("copy", () => {
  it("has no em dash or en dash anywhere in the user-facing wording", () => {
    const strings = Object.values(COPY).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v)));
    expect(strings.length).toBeGreaterThan(5);
    for (const s of strings) expect(s).not.toMatch(/[–—]/);
  });
  it("says approvals are not legal consent", () => {
    expect(COPY.approvalNote).toMatch(/not legal consent/i);
  });
});
