// Numbers and groups behind the Failures workspace (pure, no network): failed count, retries that recovered, the share of attempts that were clean
// first time, error tiles grouped by normalised error text, and the newest-first list of failures and recovered retries. Plain-language text comes
// from the app's existing helper (errorMessages.ts); nothing is invented here.

import type { ScheduledPost, SocialAccount } from "./api";
import { humanizeErrorMessage, resolveErrorDisplay } from "./errorMessages";
import { accountMatchesBrand } from "../pages/dashboard/dashboardHelpers";

export interface ErrorGroup {
  key: string;
  count: number;
  /** Plain-language explanation, without the corrective sentence. */
  message: string;
  /** The corrective step taken from the same plain-language text, or null when that text has none. */
  step: string | null;
}

export interface RecentRow {
  id: string;
  platform: string;
  message: string;
  /** ISO time of the post (its scheduled time), or null when unknown. */
  at: string | null;
  /** True when the post is still failed (it can be opened in the Failed tab); false when it failed at first but later went live. */
  failed: boolean;
}

export interface FailuresModel {
  failedCount: number;
  recovered: number;
  /** Whole percent of attempts that succeeded without any error, or null when there are no finished attempts yet. */
  cleanSharePercent: number | null;
  groups: ErrorGroup[];
  recent: RecentRow[];
}

type Result = ScheduledPost["post_results"][number];

const MAX_ROWS = 50;
const MAX_ROW_MESSAGE = 110;
const STEP_SENTENCE = /^(try|you can)\b/i;

/** Same fault, same key: lower case, every run of digits as "#", single spaces. */
export function normaliseErrorKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/** Splits a plain-language message into the explanation and its corrective sentence(s) ("Try ...", "You can ..."). */
export function splitCorrectiveStep(friendly: string): { message: string; step: string | null } {
  const sentences = friendly.split(/(?<=[.!?])\s+/).filter(Boolean);
  const steps = sentences.filter((s) => STEP_SENTENCE.test(s));
  if (steps.length === 0) return { message: friendly, step: null };
  const rest = sentences.filter((s) => !STEP_SENTENCE.test(s));
  return { message: rest.join(" "), step: steps.join(" ") };
}

/** Each brand label once, sorted, skipping accounts that have none. */
export function brandLabels(accounts: SocialAccount[]): string[] {
  const labels = new Set<string>();
  for (const a of accounts) {
    const l = a.brand_label?.trim();
    if (l) labels.add(l);
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

function shorten(text: string): string {
  return text.length > MAX_ROW_MESSAGE ? text.slice(0, MAX_ROW_MESSAGE - 1).trimEnd() + "…" : text;
}

function timeValue(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

export function buildFailuresModel(posts: ScheduledPost[], accounts: SocialAccount[], brandFilter: string): FailuresModel {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  let failedCount = 0;
  let recovered = 0;
  let attempts = 0;
  let clean = 0;
  const groups = new Map<string, ErrorGroup>();
  const recent: RecentRow[] = [];

  for (const p of posts) {
    const account = p.social_account_id ? byId.get(p.social_account_id) : undefined;
    if (!accountMatchesBrand(account, brandFilter)) continue;
    const results: Result[] = Array.isArray(p.post_results) ? p.post_results : [];
    const platform = account?.platform ?? "";
    const errors = results.filter((r) => r.error_message && r.error_message.trim());

    if (p.status === "failed") failedCount += 1;
    if (p.status === "posted" || p.status === "failed") {
      attempts += results.length;
      clean += results.length - errors.length;
    }
    if (p.status === "posted") recovered += errors.length;

    for (const r of errors) {
      const key = normaliseErrorKey(r.error_message as string);
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      const { friendly } = resolveErrorDisplay(r.error_message, r.raw_error_message, platform || undefined);
      groups.set(key, { key, count: 1, ...splitCorrectiveStep(friendly) });
    }

    const isFailed = p.status === "failed";
    if (isFailed || (p.status === "posted" && errors.length > 0)) {
      const first = errors[0];
      const friendly = first ? resolveErrorDisplay(first.error_message, first.raw_error_message, platform || undefined).friendly : humanizeErrorMessage(null).friendly;
      recent.push({ id: p.id, platform, message: shorten(friendly), at: p.scheduled_for ?? null, failed: isFailed });
    }
  }

  recent.sort((a, b) => timeValue(b.at) - timeValue(a.at));
  return {
    failedCount,
    recovered,
    cleanSharePercent: attempts > 0 ? Math.round((clean / attempts) * 100) : null,
    groups: [...groups.values()].sort((a, b) => b.count - a.count || a.message.localeCompare(b.message)),
    recent: recent.slice(0, MAX_ROWS),
  };
}
