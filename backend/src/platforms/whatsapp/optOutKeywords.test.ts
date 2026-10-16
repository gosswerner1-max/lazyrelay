// Opt-out keyword detection for inbound WhatsApp text: exact whole-message match only, so ordinary sentences never opt anyone out.
import { describe, it, expect } from "vitest";
import { isOptOutKeyword } from "./optOutKeywords.js";

describe("isOptOutKeyword", () => {
  const yes = ["STOP", "stop", "  Stop  ", "Stop.", "STOP!", "stop!!!", "UNSUBSCRIBE", "unsubscribe", "Cancel", "END", "quit", "opt out", "OPT OUT", "Opt  out", "optout", "OPTOUT", "stop all", "STOP ALL.", "Stop?"];
  const no = [
    "don't stop",
    "Don't stop",
    "please stop sending me this",
    "stop the car",
    "I want to cancel my order",
    "do not unsubscribe me",
    "stopping",
    "bus stop",
    "ending",
    "",
    "   ",
    "STOP ALL OF THESE MESSAGES NOW PLEASE", // over 20 characters, a sentence not a keyword
    "stop stop",
    "stop, thanks",
  ];

  it.each(yes)("matches %j", (text) => {
    expect(isOptOutKeyword(text)).toBe(true);
  });

  it.each(no)("does not match %j", (text) => {
    expect(isOptOutKeyword(text)).toBe(false);
  });

  it("returns false for non-strings", () => {
    expect(isOptOutKeyword(undefined as unknown as string)).toBe(false);
    expect(isOptOutKeyword(null as unknown as string)).toBe(false);
  });
});
