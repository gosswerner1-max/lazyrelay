import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { Login } from "./Login";
import { Spinner } from "../components/Spinner";
import { BrandMark } from "../components/BrandMark";
import { api } from "../lib/api";

/** Reached via the link in sendTeamInviteEmail (backend/src/email.ts):
 *  /team/accept?token=<account_members.invite_token>. Same shape as
 *  OAuthConsentPage — owns its own URL, requires a real session before it
 *  can do anything, and shows the sign-in form in place rather than
 *  bouncing the visitor elsewhere first. Unlike OAuth consent, acceptance
 *  itself is a single POST with no separate approve/deny decision — the
 *  invite link IS the decision to try; the account-owner side stays
 *  reversible via Remove in their own Team section either way. */
export function TeamAcceptInvitePage({ token }: { token: string | null }) {
  const { session, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<"idle" | "accepting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !token || status !== "idle") return;
    setStatus("accepting");
    api
      .acceptTeamInvite(token)
      .then(() => setStatus("done"))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Something went wrong accepting this invite.");
        setStatus("error");
      });
  }, [session, token, status]);

  if (!token) {
    return (
      <div className="oauth-consent-shell">
        <div className="oauth-consent-card">
          <BrandMark size={32} />
          <h1>Missing invite link</h1>
          <p className="section-note">This page is reached from a team invite email, not by visiting it directly.</p>
          <a href="/" className="oauth-consent-link">
            Back to LazyRelay
          </a>
        </div>
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className="oauth-consent-shell">
        <Spinner />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="oauth-consent-shell">
        <div className="oauth-consent-intro">
          <BrandMark size={28} />
          <p>Sign in to LazyRelay to accept this team invite. Use the same email address the invite was sent to.</p>
        </div>
        <Login onBack={() => window.location.assign("/")} />
      </div>
    );
  }

  if (status === "accepting" || status === "idle") {
    return (
      <div className="oauth-consent-shell">
        <Spinner />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="oauth-consent-shell">
        <div className="oauth-consent-card">
          <BrandMark size={32} />
          <h1>Couldn't accept this invite</h1>
          <p className="section-note">{error}</p>
          <a href="/" className="oauth-consent-link">
            Back to LazyRelay
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="oauth-consent-shell">
      <div className="oauth-consent-card">
        <BrandMark size={32} />
        <h1>You're on the team</h1>
        <p className="section-note">Signed in as {session.user.email}</p>
        <a href="/" className="oauth-consent-link">
          Go to your dashboard
        </a>
      </div>
    </div>
  );
}
