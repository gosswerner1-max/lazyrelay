// Self-reply at N likes (backend 0102): Facebook and Instagram only.

export function supportsSelfReply(platform: string | undefined): boolean {
  return platform === "facebook" || platform === "instagram";
}

/** The two request fields for one post, or nothing when it is not set up or the channel cannot do it. */
export function selfReplyFields(platform: string | undefined, text: string, likes: string): { selfReplyText?: string; selfReplyAtLikes?: number } {
  const t = text.trim();
  const n = Number(likes);
  if (!supportsSelfReply(platform) || !t || !Number.isInteger(n) || n < 1) return {};
  return { selfReplyText: t, selfReplyAtLikes: n };
}
