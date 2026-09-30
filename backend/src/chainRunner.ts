// Thread chains (master list #20): after the main post is live and verified, the
// follow-up posts are published one after another, each replying to the one before.
// Best effort by design, like the first comment: the main post is already live, so a
// failed follow-up never changes the post's own status and is never retried by
// re-running the post (that would duplicate it). How far it got is recorded.

import type { PlatformAdapter } from "./platforms/types.js";

export interface ChainOutcome {
  posted: number;
  error: string | null;
}

export async function runChain(
  adapter: Pick<PlatformAdapter, "postChainReply">,
  input: { rootPostId: string; texts: string[]; accessToken: string; platformAccountId?: string | null },
): Promise<ChainOutcome> {
  if (!adapter.postChainReply) return { posted: 0, error: "This platform cannot post a thread." };
  let parent = input.rootPostId;
  let posted = 0;
  for (const text of input.texts) {
    try {
      const r = await adapter.postChainReply({
        rootPostId: input.rootPostId,
        parentPostId: parent,
        text,
        accessToken: input.accessToken,
        platformAccountId: input.platformAccountId ?? null,
      });
      if (!r.success || !r.platformPostId) {
        return { posted, error: r.errorMessage ?? `Follow-up post ${posted + 1} was refused` };
      }
      parent = r.platformPostId;
      posted += 1;
    } catch (err) {
      return { posted, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { posted, error: null };
}
