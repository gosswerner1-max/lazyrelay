import { describe, it, expect } from "vitest";
import { isTiktokDisclosureIncomplete } from "./tiktokDisclosure";
import type { SocialAccount } from "./api";

function account(id: string, platform: string): SocialAccount {
  return {
    id,
    platform,
    platform_account_id: `${platform}-account`,
    display_name: null,
    connected_at: "2026-01-01T00:00:00Z",
    brand_label: null,
    brand_id: null,
  };
}

const tiktok = account("acc-1", "tiktok");
const instagram = account("acc-2", "instagram");

describe("isTiktokDisclosureIncomplete", () => {
  it("is false when no TikTok account is selected", () => {
    expect(isTiktokDisclosureIncomplete(["acc-2"], [tiktok, instagram], true, false, false)).toBe(false);
  });

  it("is false when TikTok is selected but disclosure is off", () => {
    expect(isTiktokDisclosureIncomplete(["acc-1"], [tiktok], false, false, false)).toBe(false);
  });

  it("is false when disclosure is on and 'your organic content' is ticked", () => {
    expect(isTiktokDisclosureIncomplete(["acc-1"], [tiktok], true, true, false)).toBe(false);
  });

  it("is false when disclosure is on and 'branded content' is ticked", () => {
    expect(isTiktokDisclosureIncomplete(["acc-1"], [tiktok], true, false, true)).toBe(false);
  });

  it("is false when disclosure is on and both options are ticked", () => {
    expect(isTiktokDisclosureIncomplete(["acc-1"], [tiktok], true, true, true)).toBe(false);
  });

  it("is true when disclosure is on and neither option is ticked — the real bug this prevents", () => {
    expect(isTiktokDisclosureIncomplete(["acc-1"], [tiktok], true, false, false)).toBe(true);
  });

  it("is true when TikTok is only one of several selected accounts", () => {
    expect(isTiktokDisclosureIncomplete(["acc-2", "acc-1"], [tiktok, instagram], true, false, false)).toBe(true);
  });

  it("is false for a non-TikTok platform regardless of the toggles", () => {
    expect(isTiktokDisclosureIncomplete(["acc-2"], [tiktok, instagram], true, false, false)).toBe(false);
  });
});
