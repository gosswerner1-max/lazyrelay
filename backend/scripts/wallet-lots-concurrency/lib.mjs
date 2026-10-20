// Pure helpers of the wallet concurrency check. No database, no network. Unit tested in lib.test.mjs.

const FLAG = "WALLET_CONCURRENCY_I_AM_A_THROWAWAY_BRANCH";
const URL_VAR = "WALLET_CONCURRENCY_DATABASE_URL";

/** Decides whether the script may run. The answer never repeats the connection string. */
export function checkGuard(env) {
  const raw = typeof env[URL_VAR] === "string" ? env[URL_VAR].trim() : "";
  if (raw === "") return { ok: false, reason: `${URL_VAR} is not set` };
  if (env[FLAG] !== "yes") return { ok: false, reason: `${FLAG} must be exactly "yes" (this script creates and drops a schema; use a throwaway branch only)` };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `${URL_VAR} is not a valid URL` };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return { ok: false, reason: `${URL_VAR} must be a postgres URL` };
  const host = parsed.hostname.toLowerCase();
  if (/prod/i.test(host)) return { ok: false, reason: "the host name looks like production; refusing" };
  const forbidden = String(env.WALLET_CONCURRENCY_FORBIDDEN_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (forbidden.includes(host)) return { ok: false, reason: "the host is on WALLET_CONCURRENCY_FORBIDDEN_HOSTS; refusing" };
  return { ok: true, url: raw };
}

/** Removes the connection strings, their passwords and their hosts from any text, so an error can be printed safely. */
export function scrub(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s !== "string" || s === "") continue;
    out = out.split(s).join("[hidden]");
    try {
      const u = new URL(s);
      for (const part of [decodeURIComponent(u.password), u.password, u.hostname, u.username]) if (part) out = out.split(part).join("[hidden]");
    } catch {
      // not a URL: only the literal text is removed
    }
  }
  return out.replace(/postgres(ql)?:\/\/\S+/gi, "[hidden]");
}

/** Moves a migration into the fixture schema: every public. reference and the pinned search_path. */
export function localizeSql(sql, schema) {
  if (!/^wl_cc_[0-9a-f]{12}$/.test(schema)) throw new Error("the fixture schema must be wl_cc_ plus 12 hex digits");
  return sql.replace(/\bpublic\./g, `${schema}.`).replace(/search_path\s*=\s*public\b/g, `search_path = ${schema}`);
}

/** Looks for a broken ledger. rows: [{d: delta, b: balance after, parts: sum of the lot breakdown}] in ledger order. Returns a reason or null. */
export function chainProblem(rows, endBalance) {
  let run = 0;
  for (const [i, r] of rows.entries()) {
    run += r.d;
    if (run !== r.b) return `chain broke at entry ${i + 1}: running ${run}, stored ${r.b}`;
    if (run < 0) return `negative balance at entry ${i + 1}`;
    if (r.parts !== Math.abs(r.d)) return `breakdown ${r.parts} differs from delta ${r.d} at entry ${i + 1}`;
  }
  return run === endBalance ? null : `end balance ${endBalance} differs from the chain ${run}`;
}

/** Judges a commit and release race on one hold: exactly one side wins, the other is refused cleanly. */
export function tallyTerminal({ commits, releases, status, commitEntries }) {
  const real = (xs) => xs.filter((x) => x.ok === true && x.replay === false).length;
  const refused = (xs) => xs.every((x) => x.ok === false && x.reason === "hold_not_held");
  if (status === "committed") {
    if (real(commits) !== 1) return { ok: false, reason: `${real(commits)} real commits` };
    if (!refused(releases)) return { ok: false, reason: "a release was not refused" };
    return commitEntries === 1 ? { ok: true, winner: "commit" } : { ok: false, reason: `${commitEntries} hold_commit entries` };
  }
  if (status === "released") {
    if (real(releases) !== 1) return { ok: false, reason: `${real(releases)} real releases` };
    if (!refused(commits)) return { ok: false, reason: "a commit was not refused" };
    return commitEntries === 0 ? { ok: true, winner: "release" } : { ok: false, reason: "a release left a hold_commit entry" };
  }
  return { ok: false, reason: `the hold ended as ${status}` };
}

/** Median of a list of numbers (0 for an empty list). */
export function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** How far ahead of the start the expiry is set: the larger of 4 seconds and 25 round trips, longer on every retry (attempt 0, 1, 2). */
export function leadMs(medianRttMs, attempt) {
  return Math.max(4000, 25 * medianRttMs) * (1 + attempt);
}

/** Splits operations into before and after the expiry by their DATABASE timestamp (op.t, a Date taken from now() inside the statement). */
export function classifyByExpiry(ops, expiry) {
  const limit = expiry.getTime();
  const out = { before: 0, after: 0, unstamped: 0 };
  for (const op of ops) {
    if (!(op.t instanceof Date)) out.unstamped += 1;
    else if (op.t.getTime() < limit) out.before += 1;
    else out.after += 1;
  }
  return out;
}

/** The race window is exercised only when at least 20 operations ran before the expiry instant and at least 20 after it. */
export function raceExercised({ before, after }) {
  return before >= 20 && after >= 20;
}
