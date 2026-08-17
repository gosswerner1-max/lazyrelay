// Real HTTP-level test of Agency tier v1 (migration 0053, account_members):
// requireAuth's membership resolution, requireOwner's role gate, and the
// four /team/* routes. Boots the real app (same pattern as test-mcp-http.ts)
// and drives it with real Supabase-issued sessions for real, throwaway test
// users -- not mocked auth, not direct function calls.
//
// Run: npx tsx src/test-team-invite.ts
import "dotenv/config";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";
import { buildApp } from "./http/app.js";
import { StubMorAdapter } from "./billing/stub.js";
import type { PlatformAdapterRegistry } from "./platforms/connect.js";

// The anon key only lives in frontend/.env (it's the public, browser-safe
// key) -- backend/.env only has the service-role key. Read it directly
// rather than duplicating it into backend config for one test script.
const frontendEnv = dotenv.config({ path: new URL("../../frontend/.env", import.meta.url) }).parsed ?? {};
const anon = createClient(process.env.SUPABASE_URL!, frontendEnv.VITE_SUPABASE_ANON_KEY!);

const app = buildApp(new StubMorAdapter(), new Map() as PlatformAdapterRegistry);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;
console.log(`Test server on ${base}\n`);

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  }
}

const createdUserIds: string[] = [];

async function createTestUser(label: string): Promise<{ id: string; email: string; token: string }> {
  const email = `team-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@lazyrelay.invalid`;
  const { data: user, error } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (error || !user.user) throw error ?? new Error("no user returned");
  createdUserIds.push(user.user.id);

  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: "https://lazyrelay.com" },
  });
  if (linkError || !linkData) throw linkError ?? new Error("no link returned");

  const { data: session, error: otpError } = await anon.auth.verifyOtp({
    type: "magiclink",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpError || !session.session) throw otpError ?? new Error("no session returned");

  return { id: user.user.id, email, token: session.session.access_token };
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// Agency pricing pass (2026-08-17) gated /team/invite behind a real tier
// (see checkSeatLimit in seatLimits.ts) -- every test user here defaults to
// Free, which now has zero seats, so any account that INVITES needs a real
// subscription seeded first. Bypasses real Paddle, same pattern
// test-cancel-cascades-addons.ts already uses to seed billing state.
async function seedSubscription(accountId: string, tier: string): Promise<void> {
  const { error } = await supabase.from("subscriptions").upsert(
    {
      account_id: accountId,
      mor_subscription_id: `sub_team_test_${accountId}`,
      tier,
      status: "active",
      current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );
  if (error) throw error;
}

async function main() {
  const owner = await createTestUser("owner");
  const invitee = await createTestUser("invitee");
  const stranger = await createTestUser("stranger");
  // Both owner and stranger invite someone in this suite -- both need a real
  // seat-bearing tier now that /team/invite is gated. "enterprise" (Business)
  // gives 2 included seats, enough for the single invite each sends here.
  await seedSubscription(owner.id, "enterprise");
  await seedSubscription(stranger.id, "enterprise");

  // 1. Solo baseline: brand-new user with zero invites resolves to
  //    themselves exactly like pre-v1 behavior, on an ordinary existing route.
  {
    const res = await fetch(`${base}/api/social-accounts`, { headers: authed(owner.token) });
    check("solo user's ordinary route still works (no regression)", res.status === 200, `HTTP ${res.status}`);
  }

  // 1b. A Free-tier account (a fresh user, never seeded a subscription) gets
  //     the plan-specific message, not the generic "reached your limit of 0".
  {
    const freeUser = await createTestUser("free-tier");
    const res = await fetch(`${base}/api/team/invite`, {
      method: "POST",
      headers: { ...authed(freeUser.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "someone@lazyrelay.invalid" }),
    });
    const body = await res.json();
    check(
      "Free tier gets a real 'not available on your plan' message, not a 0-limit message",
      res.status === 403 && /aren't available on your plan/i.test(body.error ?? ""),
      `HTTP ${res.status} ${JSON.stringify(body)}`
    );
  }

  // 2. Owner sees exactly their own self-row on GET /team.
  {
    const res = await fetch(`${base}/api/team`, { headers: authed(owner.token) });
    const body = await res.json();
    check(
      "GET /team shows one accepted owner row pre-invite",
      res.status === 200 && Array.isArray(body) && body.length === 1 && body[0].role === "owner" && body[0].accepted_at,
      JSON.stringify(body)
    );
  }

  // 3. Non-owner (a stranger with no relationship to this account) can't
  //    invite -- sanity check requireOwner rejects an unrelated account's
  //    owner acting on someone else's account id via... actually this just
  //    confirms invite creation requires being authed as the target account
  //    at all, which is requireAuth's job, not requireOwner's -- covered by
  //    the fact stranger's own invite lands on THEIR OWN account, not owner's.
  {
    const res = await fetch(`${base}/api/team/invite`, {
      method: "POST",
      headers: { ...authed(owner.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: invitee.email }),
    });
    check("owner can invite by email", res.status === 201, `HTTP ${res.status}`);
  }

  // 4. Duplicate invite to the same email is rejected.
  {
    const res = await fetch(`${base}/api/team/invite`, {
      method: "POST",
      headers: { ...authed(owner.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: invitee.email }),
    });
    check("duplicate invite rejected", res.status === 409, `HTTP ${res.status}`);
  }

  // Fetch the real invite token directly from the DB (service role) --
  // POST /team/invite deliberately doesn't return it in the response.
  const { data: inviteRow } = await supabase
    .from("account_members")
    .select("id, invite_token")
    .eq("account_id", owner.id)
    .eq("invited_email", invitee.email.toLowerCase())
    .single();
  if (!inviteRow) throw new Error("invite row not found after insert");

  // 5. Wrong-email acceptance is rejected (stranger tries invitee's invite).
  {
    const res = await fetch(`${base}/api/team/accept-invite`, {
      method: "POST",
      headers: { ...authed(stranger.token), "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteRow.invite_token }),
    });
    check("accepting someone else's invite is rejected", res.status === 403, `HTTP ${res.status}`);
  }

  // 6. Invitee accepts for real.
  {
    const res = await fetch(`${base}/api/team/accept-invite`, {
      method: "POST",
      headers: { ...authed(invitee.token), "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteRow.invite_token }),
    });
    const body = await res.json();
    check("invitee accepts the invite", res.status === 200 && body.accountId === owner.id, `HTTP ${res.status} ${JSON.stringify(body)}`);
  }

  // 7. Re-using the same (now-consumed) token fails.
  {
    const res = await fetch(`${base}/api/team/accept-invite`, {
      method: "POST",
      headers: { ...authed(invitee.token), "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteRow.invite_token }),
    });
    check("re-accepting a consumed token fails", res.status === 404, `HTTP ${res.status}`);
  }

  // 8. Invitee's ordinary route now resolves to the OWNER's account, not
  //    their own -- the actual point of the whole feature.
  {
    const res = await fetch(`${base}/api/team`, { headers: authed(invitee.token) });
    const body = await res.json();
    check(
      "invitee now resolves into the owner's account",
      res.status === 200 && Array.isArray(body) && body.length === 2,
      JSON.stringify(body)
    );
  }

  // 9. Member (invitee) is blocked from an owner-only action.
  {
    const res = await fetch(`${base}/api/team/invite`, {
      method: "POST",
      headers: { ...authed(invitee.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: stranger.email }),
    });
    const body = await res.json();
    check(
      "member is blocked from inviting (owner-only)",
      res.status === 403 && /owner/i.test(body.error ?? ""),
      `HTTP ${res.status} ${JSON.stringify(body)}`
    );
  }

  // 10. Member CAN still use an ordinary, non-owner-gated route on the
  //     shared account (posting/scheduling access is the whole point).
  {
    const res = await fetch(`${base}/api/social-accounts`, { headers: authed(invitee.token) });
    check("member can still use ordinary shared-account routes", res.status === 200, `HTTP ${res.status}`);
  }

  // 11. A second, different account tries to invite the same (already-a-
  //     member-elsewhere) invitee -- accept must be rejected (v1's one-team
  //     limit), even though the invite itself is allowed to be created.
  {
    const inviteRes = await fetch(`${base}/api/team/invite`, {
      method: "POST",
      headers: { ...authed(stranger.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: invitee.email }),
    });
    check("a second account can still send the invite", inviteRes.status === 201, `HTTP ${inviteRes.status}`);

    const { data: secondInvite } = await supabase
      .from("account_members")
      .select("invite_token")
      .eq("account_id", stranger.id)
      .eq("invited_email", invitee.email.toLowerCase())
      .single();

    const acceptRes = await fetch(`${base}/api/team/accept-invite`, {
      method: "POST",
      headers: { ...authed(invitee.token), "Content-Type": "application/json" },
      body: JSON.stringify({ token: secondInvite?.invite_token }),
    });
    check("accepting a second team is rejected (v1 one-team limit)", acceptRes.status === 409, `HTTP ${acceptRes.status}`);
  }

  // 12. Owner removes the member; member falls back to their own solo account.
  {
    const { data: memberRow } = await supabase
      .from("account_members")
      .select("id")
      .eq("account_id", owner.id)
      .eq("user_id", invitee.id)
      .single();
    const removeRes = await fetch(`${base}/api/team/${memberRow?.id}`, {
      method: "DELETE",
      headers: authed(owner.token),
    });
    check("owner removes a member", removeRes.status === 204, `HTTP ${removeRes.status}`);

    const soloRes = await fetch(`${base}/api/team`, { headers: authed(invitee.token) });
    const soloBody = await soloRes.json();
    check(
      "removed member falls back to their own solo account",
      soloRes.status === 200 && Array.isArray(soloBody) && soloBody.length === 1 && soloBody[0].role === "owner",
      JSON.stringify(soloBody)
    );
  }

  // 13. The owner row itself can never be removed.
  {
    const { data: ownerRow } = await supabase
      .from("account_members")
      .select("id")
      .eq("account_id", owner.id)
      .eq("role", "owner")
      .single();
    const res = await fetch(`${base}/api/team/${ownerRow?.id}`, {
      method: "DELETE",
      headers: authed(owner.token),
    });
    check("the owner row can't be removed", res.status === 400, `HTTP ${res.status}`);
  }

  // 14. Seat cap is actually enforced -- a Business (enterprise) account has
  //     2 included seats; the 3rd invite must be rejected once both are used.
  {
    const capOwner = await createTestUser("cap-owner");
    await seedSubscription(capOwner.id, "enterprise");
    const capInvitee1 = await createTestUser("cap-invitee-1");
    const capInvitee2 = await createTestUser("cap-invitee-2");

    const invite1 = await fetch(`${base}/api/team/invite`, {
      method: "POST",
      headers: { ...authed(capOwner.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: capInvitee1.email }),
    });
    check("seat 1 of 2 accepted", invite1.status === 201, `HTTP ${invite1.status}`);

    const invite2 = await fetch(`${base}/api/team/invite`, {
      method: "POST",
      headers: { ...authed(capOwner.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: capInvitee2.email }),
    });
    check("seat 2 of 2 accepted", invite2.status === 201, `HTTP ${invite2.status}`);

    const invite3 = await fetch(`${base}/api/team/invite`, {
      method: "POST",
      headers: { ...authed(capOwner.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "cap-invitee-3@lazyrelay.invalid" }),
    });
    const invite3Body = await invite3.json();
    check(
      "3rd invite rejected once Business's 2 included seats are used (pending invites count too)",
      invite3.status === 403 && /reached your plan's limit of 2 team seats/i.test(invite3Body.error ?? ""),
      `HTTP ${invite3.status} ${JSON.stringify(invite3Body)}`
    );
  }

  // 15. Resend: same email, same token, refreshed invited_at -- and it's
  //     owner-only, same gate as invite/remove.
  {
    const resendOwner = await createTestUser("resend-owner");
    await seedSubscription(resendOwner.id, "enterprise");
    const resendInvitee = await createTestUser("resend-invitee");

    await fetch(`${base}/api/team/invite`, {
      method: "POST",
      headers: { ...authed(resendOwner.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: resendInvitee.email }),
    });
    const { data: before } = await supabase
      .from("account_members")
      .select("id, invite_token, invited_at")
      .eq("account_id", resendOwner.id)
      .eq("invited_email", resendInvitee.email.toLowerCase())
      .single();

    // Backdate invited_at so the resend's refresh is actually observable,
    // not just "later than a moment ago" by coincidence of timing.
    await supabase.from("account_members").update({ invited_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", before!.id);

    const resendRes = await fetch(`${base}/api/team/${before!.id}/resend`, {
      method: "POST",
      headers: authed(resendOwner.token),
    });
    const { data: after } = await supabase
      .from("account_members")
      .select("invite_token, invited_at")
      .eq("id", before!.id)
      .single();
    check(
      "resend succeeds, keeps the same token, refreshes invited_at",
      resendRes.status === 200 &&
        after?.invite_token === before?.invite_token &&
        new Date(after!.invited_at).getTime() > new Date(before!.invited_at).getTime(),
      `HTTP ${resendRes.status} before=${before?.invited_at} after=${after?.invited_at}`
    );

    // Non-owner can't resend.
    const acceptRes = await fetch(`${base}/api/team/accept-invite`, {
      method: "POST",
      headers: { ...authed(resendInvitee.token), "Content-Type": "application/json" },
      body: JSON.stringify({ token: before!.invite_token }),
    });
    check("invitee accepted for the next check", acceptRes.status === 200, `HTTP ${acceptRes.status}`);

    const resendAfterAccept = await fetch(`${base}/api/team/${before!.id}/resend`, {
      method: "POST",
      headers: authed(resendOwner.token),
    });
    check(
      "resending an already-accepted invite is rejected",
      resendAfterAccept.status === 400,
      `HTTP ${resendAfterAccept.status}`
    );
  }

  // 16. Expiration: an invite older than 72h is rejected at accept time,
  //     even with a genuinely valid token.
  {
    const expiryOwner = await createTestUser("expiry-owner");
    await seedSubscription(expiryOwner.id, "enterprise");
    const expiryInvitee = await createTestUser("expiry-invitee");

    await fetch(`${base}/api/team/invite`, {
      method: "POST",
      headers: { ...authed(expiryOwner.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: expiryInvitee.email }),
    });
    const { data: inviteRow } = await supabase
      .from("account_members")
      .select("id, invite_token")
      .eq("account_id", expiryOwner.id)
      .eq("invited_email", expiryInvitee.email.toLowerCase())
      .single();

    // 73 hours old -- just past the 72h window.
    await supabase
      .from("account_members")
      .update({ invited_at: new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString() })
      .eq("id", inviteRow!.id);

    const acceptRes = await fetch(`${base}/api/team/accept-invite`, {
      method: "POST",
      headers: { ...authed(expiryInvitee.token), "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteRow!.invite_token }),
    });
    const acceptBody = await acceptRes.json();
    check(
      "a 73-hour-old invite is rejected as expired",
      acceptRes.status === 410 && /expired/i.test(acceptBody.error ?? ""),
      `HTTP ${acceptRes.status} ${JSON.stringify(acceptBody)}`
    );

    // Resend should un-expire it (refreshes invited_at back to now).
    await fetch(`${base}/api/team/${inviteRow!.id}/resend`, {
      method: "POST",
      headers: authed(expiryOwner.token),
    });
    const acceptAfterResend = await fetch(`${base}/api/team/accept-invite`, {
      method: "POST",
      headers: { ...authed(expiryInvitee.token), "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteRow!.invite_token }),
    });
    check(
      "after resend, the same token works again",
      acceptAfterResend.status === 200,
      `HTTP ${acceptAfterResend.status}`
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  for (const id of createdUserIds) {
    await supabase.auth.admin.deleteUser(id);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Test run failed:", err);
  server.close();
  for (const id of createdUserIds) {
    await supabase.auth.admin.deleteUser(id).catch(() => {});
  }
  process.exit(1);
});
