import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { supabase } from "./supabase.js";

// Real, live-database verification for the 2026-09-06 requireAuth MFA fix —
// same discipline as security-test.ts: creates a real throwaway account,
// runs the actual enrollment/challenge/verify flow against real Supabase
// Auth (not mocked), and hits the real local backend. This is the one test
// in this project that has to generate valid TOTP codes for real, since no
// TOTP library is a dependency here — the RFC 6238 algorithm is short
// enough to write directly rather than adding one just for this test.

const API_URL = "http://localhost:3000/api";
let failures = 0;

function report(label: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures++;
}

const authClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

/** RFC 4648 base32 decode — Supabase returns the TOTP secret this way. */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/=+$/, "");
  let bits = "";
  for (const char of clean) {
    const val = alphabet.indexOf(char);
    if (val === -1) throw new Error(`Invalid base32 character in TOTP secret: ${char}`);
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP — 30s step, 6 digits, HMAC-SHA1 (Supabase's TOTP default). */
function generateTotp(secretBase32: string, forTimeMs = Date.now()): string {
  const counter = Math.floor(forTimeMs / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const key = base32Decode(secretBase32);
  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (binCode % 1_000_000).toString().padStart(6, "0");
}

async function main() {
  const email = `mfa-enforce-test-${Date.now()}@lazyrelay.invalid`;
  const password = "MfaEnforceTest123!";
  const { data: user, error: createError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (createError || !user.user) throw createError ?? new Error("no user created");
  const userId = user.user.id;

  try {
    // 1. Baseline / no-regression check: BEFORE any MFA factor exists, a
    // fresh aal1 sign-in must still work normally.
    const { data: preEnroll, error: preEnrollError } = await authClient.auth.signInWithPassword({ email, password });
    if (preEnrollError || !preEnroll.session) throw preEnrollError ?? new Error("no session (pre-enroll)");
    const preEnrollToken = preEnroll.session.access_token;

    const baselineRes = await fetch(`${API_URL}/social-accounts`, { headers: { Authorization: `Bearer ${preEnrollToken}` } });
    report("aal1 token on a NON-MFA account is accepted (no regression)", baselineRes.status === 200, `status ${baselineRes.status}`);

    // 2. Enroll a real TOTP factor on that same session.
    const enrollClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    await enrollClient.auth.setSession({ access_token: preEnrollToken, refresh_token: preEnroll.session.refresh_token });
    const { data: enrollData, error: enrollError } = await enrollClient.auth.mfa.enroll({ factorType: "totp" });
    if (enrollError || !enrollData) throw enrollError ?? new Error("enroll failed");
    const factorId = enrollData.id;
    const secret = enrollData.totp.secret;

    const { data: challengeData, error: challengeError } = await enrollClient.auth.mfa.challenge({ factorId });
    if (challengeError || !challengeData) throw challengeError ?? new Error("initial challenge failed");
    const { error: verifyError } = await enrollClient.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code: generateTotp(secret),
    });
    if (verifyError) throw verifyError;

    // 3. THE REAL TEST — a completely FRESH sign-in (password only, no MFA
    // step) on this now-MFA-enrolled account must come back at aal1, and
    // requireAuth must now reject it. Before this fix, this returned 200.
    const { data: postEnrollSignIn, error: postEnrollError } = await authClient.auth.signInWithPassword({ email, password });
    if (postEnrollError || !postEnrollSignIn.session) throw postEnrollError ?? new Error("no session (post-enroll)");
    const aal1TokenOnMfaAccount = postEnrollSignIn.session.access_token;

    const blockedRes = await fetch(`${API_URL}/social-accounts`, { headers: { Authorization: `Bearer ${aal1TokenOnMfaAccount}` } });
    report(
      "aal1 token on an MFA-ENROLLED account is REJECTED — the actual fix",
      blockedRes.status === 401,
      `status ${blockedRes.status}`,
    );

    // 4. Complete the real MFA challenge on that SAME fresh session, then
    // confirm the resulting aal2 token IS accepted — proves the fix
    // specifically requires the real second factor, not just blocking
    // everything from this account.
    const postEnrollClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    await postEnrollClient.auth.setSession({ access_token: aal1TokenOnMfaAccount, refresh_token: postEnrollSignIn.session.refresh_token });
    const { data: challenge2, error: challenge2Error } = await postEnrollClient.auth.mfa.challenge({ factorId });
    if (challenge2Error || !challenge2) throw challenge2Error ?? new Error("second challenge failed");
    const { data: verify2, error: verify2Error } = await postEnrollClient.auth.mfa.verify({
      factorId,
      challengeId: challenge2.id,
      code: generateTotp(secret),
    });
    if (verify2Error || !verify2) throw verify2Error ?? new Error("second verify failed");
    const aal2Token = verify2.access_token;

    const allowedRes = await fetch(`${API_URL}/social-accounts`, { headers: { Authorization: `Bearer ${aal2Token}` } });
    report("aal2 token (real MFA completed) on the SAME account IS accepted", allowedRes.status === 200, `status ${allowedRes.status}`);
  } finally {
    await supabase.auth.admin.deleteUser(userId);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("MFA enforcement test crashed:", err);
  process.exit(1);
});
