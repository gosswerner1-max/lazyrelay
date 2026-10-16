// Frontend lock wording for the customer's own X keys and own WhatsApp credentials. The backend decides (allowed, requiresPlan);
// the UI only reflects it. Every PAID tier is open from Starter up, so the lock note must never name a higher plan.

import { describe, it, expect } from "vitest";
import { upgradeNote } from "./whatsappByok";
import { xTileState } from "./xByok";

const PAID = ["Starter", "Pro", "Business", "Agency", "Agency Plus"];

describe("the lock wording", () => {
  it.each(["Starter", "Pro", "Business", undefined])("the upgrade note says any paid plan whatever the server names (%s)", (plan) => {
    expect(upgradeNote({ requiresPlan: plan })).toBe("Available on any paid plan.");
    expect(upgradeNote({ requiresPlan: plan })).not.toMatch(/Pro|Business|Agency|and above/);
  });

  it("a free or lapsed account (allowed false) sees the Starter upgrade, every paid tier (allowed true) just connects", () => {
    expect(xTileState({ allowed: false, requiresPlan: "Starter" })).toEqual({ kind: "upgrade", label: "Upgrade to Starter" });
    expect(xTileState({ allowed: false })).toEqual({ kind: "upgrade", label: "Upgrade to Starter" });
    for (const tier of PAID) expect(xTileState({ allowed: true, requiresPlan: "Starter" }), tier).toEqual({ kind: "connect" });
  });
});
