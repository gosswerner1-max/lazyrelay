// The details the server sends with a 422 "platform_daily_limit" (see
// backend/src/postCreation.ts checkPlatformPostLimit). Turned into the text of
// the popup that explains WHY a post was not scheduled, not just that it was
// refused. Only Pinterest has a cap today, so the wording is Pinterest's;
// another platform falls back to a plain generic reason.

export interface PlatformLimitDetail {
  platform: string;
  limit: number;
  fullLimit?: number;
  warmingUp?: boolean;
  warmupEndsAt?: string | null;
  nextAvailable: string;
}

export const PLATFORM_LIMIT_EVENT = "lazyrelay:platform-limit";

export function isPlatformLimitDetail(body: unknown): body is PlatformLimitDetail & { code: "platform_daily_limit" } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === "platform_daily_limit" &&
    typeof (body as { platform?: unknown }).platform === "string" &&
    typeof (body as { limit?: unknown }).limit === "number" &&
    typeof (body as { nextAvailable?: unknown }).nextAvailable === "string"
  );
}

const defaultFormat = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const defaultDate = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long" });

const pins = (n: number): string => `${n} ${n === 1 ? "pin" : "pins"}`;

export function describePlatformLimit(
  d: PlatformLimitDetail,
  formatTime: (iso: string) => string = defaultFormat,
  formatDate: (iso: string) => string = defaultDate,
): { title: string; paragraphs: string[] } {
  if (d.platform !== "pinterest") {
    const name = d.platform.charAt(0).toUpperCase() + d.platform.slice(1);
    return {
      title: `${name} daily limit reached`,
      paragraphs: [
        `This post wasn't scheduled. LazyRelay allows up to ${d.limit} posts a day per ${name} account, and that day is full.`,
        `The next free time is ${formatTime(d.nextAvailable)}.`,
      ],
    };
  }

  if (d.warmingUp) {
    const ends = d.warmupEndsAt && d.fullLimit ? ` up to ${d.fullLimit} a day from ${formatDate(d.warmupEndsAt)}` : "";
    return {
      title: "This Pinterest account is still warming up",
      paragraphs: [
        `This post wasn't scheduled. While a new Pinterest account warms up, LazyRelay allows ${pins(d.limit)} a day.`,
        `Why: Pinterest treats a new account that posts a lot as spam, and can block it. So the limit rises step by step (1 a day the first week, then 2, then 3)${ends}.`,
        `The next free time is ${formatTime(d.nextAvailable)}.`,
        `Already warmed this account up by hand? Reconnect it and tick "already warmed up" when LazyRelay asks you to confirm.`,
      ],
    };
  }

  return {
    title: "Pinterest daily limit reached",
    paragraphs: [
      `This post wasn't scheduled. LazyRelay allows up to ${pins(d.limit)} a day per Pinterest account, and that day is full.`,
      `Why: Pinterest treats a lot of pins from one account as spam, and can block the account or your website. Staying under the limit protects yours.`,
      `The next free time is ${formatTime(d.nextAvailable)}. You can pick that time, or spread your pins across more days.`,
      `Promoting a new website? Start slowly and vary your captions.`,
    ],
  };
}
