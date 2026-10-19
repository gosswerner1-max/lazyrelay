// Publish hooks: two observe-only points around a scheduled post, for things that want to WATCH a publish (metrics, audit, a future
// integration) without ever being able to change or block one.
//
// Locked rules (Werner):
//   - The registry is EMPTY by default. Nothing in production registers a handler, so by default this does nothing at all.
//   - Observe-only: every handler gets its own deep-frozen copy of the context, so it cannot alter the post or the next handler's view.
//   - The context carries ids and metadata only: never post text, media URLs, tokens or credentials.
//   - Failure-safe: a handler that throws or hangs is logged ("[publish-hook]", point, name, reason) and publishing carries on. The
//     emit functions never throw, handlers run concurrently, and the caller waits at most PUBLISH_HOOK_TIMEOUT_MS in total.

export type PublishHookPoint = "before_publish" | "after_verify";

/** The longest the scheduler ever waits for the handlers of one hook point, however many there are. */
export const PUBLISH_HOOK_TIMEOUT_MS = 250;

export interface BeforePublishContext {
  postId: string;
  accountId: string;
  socialAccountId: string;
  platform: string;
  scheduledFor: string | null;
  /** 1 for the first try, 2 for the first retry, and so on. */
  attempt: number;
}

export interface AfterVerifyContext extends BeforePublishContext {
  verifiedLive: boolean;
  platformPostId?: string;
}

interface ContextByPoint {
  before_publish: BeforePublishContext;
  after_verify: AfterVerifyContext;
}

type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
export type PublishHookHandler<P extends PublishHookPoint> = (ctx: DeepReadonly<ContextByPoint[P]>) => void | Promise<void>;

interface Registered {
  name: string;
  handler: PublishHookHandler<PublishHookPoint>;
}

const registry: Record<PublishHookPoint, Registered[]> = { before_publish: [], after_verify: [] };

export function registerPublishHook<P extends PublishHookPoint>(point: P, name: string, handler: PublishHookHandler<P>): void {
  registry[point].push({ name, handler: handler as PublishHookHandler<PublishHookPoint> });
}

/** Tests only: empties the registry. */
export function resetPublishHooks(): void {
  registry.before_publish = [];
  registry.after_verify = [];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function runOne(point: PublishHookPoint, { name, handler }: Registered, ctx: unknown): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cutOff = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cutOff = true;
      reject(new Error(`timed out after ${PUBLISH_HOOK_TIMEOUT_MS} ms`));
    }, PUBLISH_HOOK_TIMEOUT_MS);
  });
  // new Promise turns a synchronous throw into a rejection. A handler that fails AFTER it was cut off would otherwise be an
  // unhandled rejection: it is logged here instead.
  const work = new Promise<void>((resolve) => resolve(handler(deepFreeze(structuredClone(ctx)) as never)));
  work.catch((err) => {
    if (cutOff) console.error("[publish-hook]", point, name, `failed after the timeout: ${reasonOf(err)}`);
  });
  try {
    await Promise.race([work, timeout]);
  } catch (err) {
    console.error("[publish-hook]", point, name, reasonOf(err));
  } finally {
    clearTimeout(timer);
  }
}

async function emit<P extends PublishHookPoint>(point: P, ctx: ContextByPoint[P]): Promise<void> {
  const handlers = registry[point];
  if (handlers.length === 0) return;
  try {
    await Promise.all([...handlers].map((h) => runOne(point, h, ctx)));
  } catch (err) {
    console.error("[publish-hook]", point, "emit", reasonOf(err));
  }
}

export const emitBeforePublish = (ctx: BeforePublishContext): Promise<void> => emit("before_publish", ctx);
export const emitAfterVerify = (ctx: AfterVerifyContext): Promise<void> => emit("after_verify", ctx);
