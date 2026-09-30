// Self-reply at N likes (master list #17). A customer can attach a follow-up
// comment to a post that LazyRelay adds once the post reaches N likes. Only
// platforms with a comment API can do it (Facebook, Instagram today). Runs from
// the metrics poller, so it fires at the first engagement checkpoint after the
// like count is reached. One-shot: self_reply_done_at is set whether it worked or not.

export const SELF_REPLY_PLATFORMS = ["facebook", "instagram"];
export const MAX_SELF_REPLY_LENGTH = 2200;
export const MAX_SELF_REPLY_LIKES = 1_000_000;

export type SelfReplyInput = { text: string; atLikes: number } | null;

export function normalizeSelfReply(
  text: unknown,
  atLikes: unknown,
  platform: string,
): { ok: true; value: SelfReplyInput } | { ok: false; error: string } {
  const noText = text === undefined || text === null || (typeof text === "string" && text.trim() === "");
  const noLikes = atLikes === undefined || atLikes === null || atLikes === "";
  if (noText && noLikes) return { ok: true, value: null };
  if (noText || noLikes) return { ok: false, error: "A self-reply needs both selfReplyText and selfReplyAtLikes" };
  if (typeof text !== "string") return { ok: false, error: "selfReplyText must be text" };
  const n = typeof atLikes === "number" ? atLikes : Number(atLikes);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SELF_REPLY_LIKES) {
    return { ok: false, error: `selfReplyAtLikes must be a whole number from 1 to ${MAX_SELF_REPLY_LIKES}` };
  }
  if (text.trim().length > MAX_SELF_REPLY_LENGTH) return { ok: false, error: `selfReplyText must be ${MAX_SELF_REPLY_LENGTH} characters or fewer` };
  if (!SELF_REPLY_PLATFORMS.includes(platform)) {
    return { ok: false, error: "Self-replies are only available for Facebook and Instagram posts" };
  }
  return { ok: true, value: { text: text.trim(), atLikes: n } };
}

/** True when a reply is set, not yet sent, and the post has reached its like target. */
export function shouldSelfReply(post: { self_reply_text: string | null; self_reply_at_likes: number | null; self_reply_done_at: string | null }, likes: number | null): boolean {
  if (!post.self_reply_text || post.self_reply_at_likes == null || post.self_reply_done_at) return false;
  return likes != null && likes >= post.self_reply_at_likes;
}

export interface SelfReplyPost {
  self_reply_text: string | null;
  self_reply_at_likes: number | null;
  self_reply_done_at: string | null;
}

/**
 * Sends the reply if it is due and records the outcome exactly once. `send` posts
 * the comment; `record` saves { done_at, error }. Any throw from `send` is caught and
 * recorded, so one bad reply can never stop the poller's other posts. Returns whether
 * a reply was attempted.
 */
export async function runSelfReply(
  post: SelfReplyPost,
  likes: number | null,
  send: (text: string) => Promise<{ success: boolean; errorMessage: string | null }>,
  record: (outcome: { doneAt: string; error: string | null }) => Promise<void>,
): Promise<boolean> {
  if (!shouldSelfReply(post, likes)) return false;
  let error: string | null = null;
  try {
    const r = await send(post.self_reply_text as string);
    if (!r.success) error = r.errorMessage ?? "The platform refused the comment";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await record({ doneAt: new Date().toISOString(), error });
  return true;
}
