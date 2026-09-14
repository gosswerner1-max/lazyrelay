import type { SocialAccount } from "./api";

// TikTok Content Sharing Guidelines, "Required UX Implementation" point 3a:
// disclosure toggle on + neither option ticked => publish is disabled, and
// hovering must show TIKTOK_DISCLOSURE_HOVER (Dashboard.tsx). Single source
// of truth for the rule -- it used to be written out independently in two
// places (the button-disable state and submitPost's click-time check),
// which could silently drift apart on a future edit.
export function isTiktokDisclosureIncomplete(
  selectedAccountIds: string[],
  accounts: SocialAccount[],
  discloseCommercial: boolean,
  brandOrganic: boolean,
  brandContent: boolean,
): boolean {
  return (
    selectedAccountIds.some((id) => accounts.find((a) => a.id === id)?.platform === "tiktok") &&
    discloseCommercial &&
    !brandOrganic &&
    !brandContent
  );
}
