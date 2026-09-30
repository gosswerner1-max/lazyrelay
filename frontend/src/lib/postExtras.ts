// A short line under a post in the list about its optional extras: tags, extra
// images and the self-reply (and how that went).

import type { ScheduledPost } from "./api";

export function describeExtras(p: Pick<ScheduledPost, "tags" | "media_urls" | "self_reply_text" | "self_reply_at_likes" | "self_reply_done_at" | "self_reply_error">): string[] {
  const out: string[] = [];
  if (p.tags && p.tags.length > 0) out.push(`Tags: ${p.tags.join(", ")}`);
  const extra = p.media_urls?.length ?? 0;
  if (extra > 0) out.push(`${extra + 1} images`);
  if (p.self_reply_text && p.self_reply_at_likes) {
    if (p.self_reply_done_at) {
      out.push(p.self_reply_error ? `Self-reply could not be sent: ${p.self_reply_error}` : "Self-reply sent");
    } else {
      out.push(`Self-reply at ${p.self_reply_at_likes} likes`);
    }
  }
  return out;
}
