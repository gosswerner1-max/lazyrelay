// Delay before the first comment (backend 0112): Facebook and Instagram only.
// 0 means "right away", as before. Matches backend/src/firstCommentDelay.ts.

export const FIRST_COMMENT_DELAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Right away" },
  { value: 5, label: "After 5 minutes" },
  { value: 15, label: "After 15 minutes" },
  { value: 30, label: "After 30 minutes" },
  { value: 60, label: "After 1 hour" },
  { value: 120, label: "After 2 hours" },
  { value: 360, label: "After 6 hours" },
  { value: 1440, label: "After 24 hours" },
];

export function supportsFirstCommentDelay(platform: string | undefined): boolean {
  return platform === "facebook" || platform === "instagram";
}

/** True when the select should show: a first comment is typed and a chosen account can delay it. */
export function showFirstCommentDelay(firstComment: string | null | undefined, platforms: Array<string | undefined>): boolean {
  return !!firstComment && firstComment.trim() !== "" && platforms.some(supportsFirstCommentDelay);
}

/** The request field for one post, or nothing when it is "right away", there is no comment, or the platform cannot do it. */
export function firstCommentDelayField(
  platform: string | undefined,
  firstComment: string | null | undefined,
  minutes: number | string | null | undefined,
): { firstCommentDelayMinutes?: number } {
  const n = Number(minutes);
  if (!supportsFirstCommentDelay(platform) || !firstComment || firstComment.trim() === "" || !Number.isInteger(n) || n <= 0) return {};
  return { firstCommentDelayMinutes: n };
}

/** For a draft, which has no platform yet: the delay to keep, or null to clear it. */
export function firstCommentDelayForDraft(firstComment: string | null | undefined, minutes: number | string | null | undefined): number | null {
  const n = Number(minutes);
  return firstComment && firstComment.trim() !== "" && Number.isInteger(n) && n > 0 ? n : null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "14:30", or "14:30 on 2 Oct" when it is not today. */
export function formatDueTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hhmm;
  return `${hhmm} on ${d.getDate()} ${d.toLocaleDateString("en-GB", { month: "short" })}`;
}

export function delayLabel(minutes: number): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  return `${minutes} minutes`;
}

interface FirstCommentPost {
  first_comment?: string | null;
  first_comment_delay_minutes?: number | null;
  status?: string;
  post_results?: Array<{ first_comment_posted?: boolean | null; first_comment_error?: string | null; first_comment_due_at?: string | null }>;
}

/** Short lines for the posts list: what is planned, when a held-back comment is due, and how it went. */
export function describeFirstComment(p: FirstCommentPost, now: Date = new Date()): string[] {
  if (!p.first_comment) return [];
  const result = p.post_results?.[0];
  if (result?.first_comment_posted === true) return ["First comment posted"];
  if (result?.first_comment_posted === false) return [`First comment could not be posted: ${result.first_comment_error ?? "no reason given"}`];
  if (result?.first_comment_due_at) return [`Comment due at ${formatDueTime(result.first_comment_due_at, now)}`];
  const delay = p.first_comment_delay_minutes;
  if (delay && delay > 0 && p.status !== "posted" && p.status !== "failed") return [`First comment ${delayLabel(delay)} after it goes live`];
  return [];
}
