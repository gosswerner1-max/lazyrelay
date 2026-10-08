"use strict";
// Partner program (Step 6, 2026-10-08): unique partner codes and tracked referral links, no database access, no randomness you cannot inject.
//
// generatePartnerCode(name, isTaken)  -> a free, valid code like "sarah" or "sarahk7"
// buildReferralUrl({ code, plan, path, channel })  -> the exact link a partner shares
// readReferralParams(search)          -> the same ref/promo reading rules the website uses (frontend/src/lib/referral.ts, promo.ts)
//
// Why codes are letters and numbers only, 4 to 20 long: on Plan A the code is ALSO a real Paddle discount code, and Paddle accepts only
// letters and numbers (1 to 32 characters, not case sensitive: developer.paddle.com, "Create a discount"). A hyphen would make the
// discount impossible to create. 20 keeps links short. The database column itself allows more (hyphens, up to 40) for older codes.
const crypto = require("node:crypto");

const ORIGIN = "https://lazyrelay.com";
const CODE_RE = /^[a-z0-9]{4,20}$/;
const LEGACY_CODE_RE = /^[a-z0-9-]{3,40}$/; // what the table and the website already accept
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // no 0, 1, i, l or o: nothing to misread when a code is read aloud
const RESERVED = new Set([
  "admin", "api", "app", "auth", "billing", "blog", "contact", "dashboard", "docs", "free", "help", "lazyrelay", "login", "logout", "mcp",
  "partner", "partners", "pricing", "privacy", "refunds", "root", "signup", "status", "support", "team", "terms", "test", "demo", "paddle",
  "null", "undefined", "www", "staff", "official", "promo", "coupon", "discount", "sale", "save", "ref", "referral", "affiliate",
]);

const defaultRng = (max) => crypto.randomInt(max);

function slugify(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 10);
}

function suffix(rng, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[rng(ALPHABET.length)];
  return s;
}

/** isTaken(code) must answer synchronously (load the existing codes into a Set first). Throws if no free code is found in 60 tries. */
function generatePartnerCode(name, isTaken, rng = defaultRng) {
  const base = slugify(name);
  const free = (c) => CODE_RE.test(c) && !RESERVED.has(c) && !isTaken(c);
  if (free(base)) return base;
  const stem = base.length >= 2 ? base : "partner";
  for (let i = 0; i < 60; i++) {
    const len = i < 25 ? 2 : i < 45 ? 3 : 4;
    const c = stem + suffix(rng, len);
    if (free(c)) return c;
  }
  throw new Error("could not find a free partner code");
}

/** Plan A codes double as Paddle discount codes, so they must also pass Paddle's own pattern. */
function isPaddleSafe(code) {
  return /^[a-zA-Z0-9]{1,32}$/.test(code);
}

/**
 * The link a partner shares.
 *   Plan A: ?promo=<code> (auto-applies the Paddle discount and carries checkout attribution) plus ?ref=<code> (signup capture)
 *   Plan B: ?ref=<code>
 * With utm = true (default) it also adds utm_source=partner, utm_medium=referral, utm_campaign=<code> and, if channel is given,
 * utm_content=<channel> (for example "youtube" or "newsletter") so each place a partner posts can be told apart in web analytics.
 * The website ignores the utm_ words; nothing else about the link changes how attribution works.
 */
function buildReferralUrl({ code, plan = "B", path = "/", channel, origin = ORIGIN, utm = true }) {
  const c = String(code ?? "").trim().toLowerCase();
  if (!LEGACY_CODE_RE.test(c)) throw new Error(`not a valid partner code: "${code}"`);
  const p = String(plan).toUpperCase();
  if (p !== "A" && p !== "B") throw new Error(`plan must be A or B, got "${plan}"`);
  if (p === "A" && !isPaddleSafe(c)) throw new Error(`code "${c}" cannot be a Paddle discount code (letters and numbers only)`);
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[?#\s]/.test(path)) throw new Error(`path must start with a single "/" and contain no ? # or spaces, got "${path}"`);
  if (channel !== undefined && !/^[a-z0-9_-]{1,30}$/.test(channel)) throw new Error(`channel must be 1 to 30 lowercase letters, numbers, - or _, got "${channel}"`);
  const q = new URLSearchParams();
  if (p === "A") q.set("promo", c);
  q.set("ref", c);
  if (utm) {
    q.set("utm_source", "partner");
    q.set("utm_medium", "referral");
    q.set("utm_campaign", c);
    if (channel) q.set("utm_content", channel);
  }
  return `${origin}${path}?${q.toString()}`;
}

/** Same rules as frontend/src/lib/referral.ts readRefParam (trim, lower-case, 1 to 40 characters). Returns { ref, promo } or nulls. */
function readReferralParams(search) {
  const sp = new URLSearchParams(search);
  const norm = (v) => {
    if (!v) return null;
    const t = v.trim().toLowerCase();
    return t.length > 0 && t.length <= 40 ? t : null;
  };
  return { ref: norm(sp.get("ref")), promo: norm(sp.get("promo")) };
}

module.exports = { generatePartnerCode, buildReferralUrl, readReferralParams, isPaddleSafe, slugify, CODE_RE, RESERVED, ORIGIN };
