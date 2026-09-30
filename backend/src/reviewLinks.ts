// Client review links (master list #23): helpers shared by the owner routes and the
// public review routes.

import { randomBytes } from "node:crypto";
import { supabase } from "./supabase.js";

export const REVIEW_LINK_DEFAULT_DAYS = 30;
export const REVIEW_LINK_MAX_DAYS = 90;
export const MAX_REVIEW_NAME_LENGTH = 60;
export const MAX_REVIEW_COMMENT_LENGTH = 1000;
export const MAX_COMMENTS_PER_POST = 100;
export const MAX_POSTS_ON_REVIEW_PAGE = 50;

/** A long random token: the link's only credential. 32 bytes = 256 bits. */
export function generateReviewToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are 43 characters of base64url; anything else is not worth a database lookup. */
export function looksLikeReviewToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function cleanName(v: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof v !== "string" || v.trim() === "") return { ok: false, error: "Please enter your name." };
  const name = v.trim().replace(/\s+/g, " ");
  if (name.length > MAX_REVIEW_NAME_LENGTH) return { ok: false, error: `Your name must be ${MAX_REVIEW_NAME_LENGTH} characters or fewer.` };
  return { ok: true, name };
}

export function cleanComment(v: unknown, required: boolean): { ok: true; body: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    return required ? { ok: false, error: "Please write a comment." } : { ok: true, body: null };
  }
  if (typeof v !== "string") return { ok: false, error: "The comment must be text." };
  const body = v.trim();
  if (body.length > MAX_REVIEW_COMMENT_LENGTH) return { ok: false, error: `A comment must be ${MAX_REVIEW_COMMENT_LENGTH} characters or fewer.` };
  return { ok: true, body };
}

export interface ReviewLinkRow {
  id: string;
  account_id: string;
  token: string;
  label: string | null;
  brand_label: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_viewed_at: string | null;
  created_at: string;
}

/** The link for this token if it exists, is not revoked and has not expired. */
export async function loadUsableLink(token: unknown, now: Date = new Date()): Promise<ReviewLinkRow | null> {
  if (!looksLikeReviewToken(token)) return null;
  const { data } = await supabase.from("review_links").select("id, account_id, token, label, brand_label, expires_at, revoked_at, last_viewed_at, created_at").eq("token", token).maybeSingle();
  const row = data as ReviewLinkRow | null;
  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= now.getTime()) return null;
  return row;
}

export function linkStatus(row: Pick<ReviewLinkRow, "expires_at" | "revoked_at">, now: Date = new Date()): "active" | "expired" | "revoked" {
  if (row.revoked_at) return "revoked";
  return new Date(row.expires_at).getTime() <= now.getTime() ? "expired" : "active";
}
