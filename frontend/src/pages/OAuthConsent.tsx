import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import { Login } from "./Login";
import { Spinner } from "../components/Spinner";
import { BrandMark } from "../components/BrandMark";
import { MfaChallenge } from "../components/MfaChallenge";
import { describeScopes } from "../lib/oauthScopes";

type Details = {
  authorization_id: string;
  client: { id: string; name: string; uri: string; logo_uri: string };
  scope: string;
};

/** The OAuth consent screen Supabase's OAuth 2.1 server redirects to —
 *  configured as the project's Authorization Path (Supabase dashboard:
 *  Authentication -> OAuth Server -> Authorization Path = /oauth/consent).
 *  Supabase itself only issues the authorization_id and validates the
 *  underlying OAuth request; approving or denying access, and the screen a
 *  customer actually sees, is entirely this app's responsibility.
 *
 *  Reached mid-flow when an AI agent (e.g. Claude connecting to LazyRelay's
 *  hosted MCP server) asks a customer to authorize it. A customer must be
 *  signed in to LazyRelay to grant access to their OWN account — Supabase's
 *  own getAuthorizationDetails call requires a live session and returns
 *  AuthSessionMissingError otherwise, so signing in first is not optional. */
export function OAuthConsentPage({ authorizationId }: { authorizationId: string | null }) {
  const { session, loading: authLoading } = useAuth();
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(true);
  const [redirecting, setRedirecting] = useState(false);
  const [deciding, setDeciding] = useState<"approve" | "deny" | null>(null);

  // SECURITY FIX (2026-09-14): this screen had no MFA step-up check of
  // its own, unlike App.tsx's main dashboard gate -- an aal1 session
  // (valid password auth, TOTP not yet completed this session) could
  // reach and click Approve here. This is the same client-side gate
  // App.tsx already uses (see its own comment), applied to this screen
  // too. It's real defense-in-depth, not a substitute for server-side
  // enforcement -- approveAuthorization calls directly into Supabase's
  // own managed OAuth 2.1 server (see this file's header comment), so
  // whether THAT endpoint itself rejects an aal1 call on an MFA-enrolled
  // account is Supabase platform behavior this codebase has no visibility
  // into and this fix does not verify either way.
  const [needsMfaChallenge, setNeedsMfaChallenge] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!session) {
      setNeedsMfaChallenge(undefined);
      return;
    }
    let cancelled = false;
    supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data, error }) => {
      if (cancelled) return;
      setNeedsMfaChallenge(!error && data.nextLevel !== data.currentLevel);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!session || !authorizationId) return;
    let cancelled = false;
    setLoadingDetails(true);
    supabase.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data, error: err }) => {
      if (cancelled) return;
      if (err) {
        setError(
          err.message || "This authorization link is invalid, expired, or was already used. Ask the app to try connecting again."
        );
        setLoadingDetails(false);
        return;
      }
      if (data && "redirect_url" in data) {
        // Already consented (e.g. a re-opened tab) — Supabase says go
        // straight back to the requesting app, nothing for the customer to
        // decide here.
        setRedirecting(true);
        window.location.assign(data.redirect_url);
        return;
      }
      setDetails(data as Details);
      setLoadingDetails(false);
    });
    return () => {
      cancelled = true;
    };
  }, [session, authorizationId]);

  async function decide(action: "approve" | "deny") {
    if (!authorizationId) return;
    setDeciding(action);
    const { error: err } =
      action === "approve"
        ? await supabase.auth.oauth.approveAuthorization(authorizationId)
        : await supabase.auth.oauth.denyAuthorization(authorizationId);
    // approveAuthorization/denyAuthorization redirect the browser
    // themselves on success (window.location.assign), so reaching this
    // line at all means it failed — a successful call navigates away
    // before setDeciding(null) would ever run.
    if (err) {
      setError(err.message || "Something went wrong recording your decision. Please try again.");
      setDeciding(null);
    }
  }

  if (!authorizationId) {
    return (
      <div className="oauth-consent-shell">
        <div className="oauth-consent-card">
          <BrandMark size={32} />
          <h1>Missing authorization request</h1>
          <p className="section-note">
            This page is reached from an app asking to connect to your LazyRelay account, not by visiting it directly.
          </p>
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
    // Sign in first, then this component re-renders with a session and
    // proceeds to fetch the authorization details automatically — no
    // separate "continue" step needed. Rendered bare (no extra wrapper/
    // intro text) so this looks exactly like the standalone /login route —
    // Login already provides its own complete full-page shell, and an
    // earlier version wrapping it in .oauth-consent-shell double-stacked
    // two full-page shells (Werner caught the visible dead space live).
    return <Login onBack={() => window.location.assign("/")} />;
  }

  // Deliberately checked before anything else that could reveal or act on
  // the authorization request -- an aal1 session on an MFA-enrolled
  // account completes the TOTP challenge here before it can even see
  // what it's being asked to approve.
  if (needsMfaChallenge) {
    return <MfaChallenge />;
  }

  if (redirecting || loadingDetails) {
    return (
      <div className="oauth-consent-shell">
        <Spinner />
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="oauth-consent-shell">
        <div className="oauth-consent-card">
          <BrandMark size={32} />
          <h1>Couldn't load this request</h1>
          <p className="section-note">{error ?? "Something went wrong."}</p>
          <a href="/" className="oauth-consent-link">
            Back to LazyRelay
          </a>
        </div>
      </div>
    );
  }

  const scopes = describeScopes(details.scope);

  return (
    <div className="oauth-consent-shell">
      <div className="oauth-consent-card">
        <BrandMark size={32} />
        {details.client.logo_uri && (
          <img src={details.client.logo_uri} alt={`${details.client.name} logo`} className="oauth-consent-client-logo" />
        )}
        <h1>{details.client.name} wants to connect to your LazyRelay account</h1>
        <p className="section-note">Signed in as {session.user.email}</p>

        {scopes.length > 0 && (
          <ul className="oauth-consent-scopes">
            {scopes.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}

        <p className="section-note">
          {details.client.name} will be able to act on your LazyRelay account through the API, for example scheduling
          posts and reading analytics, depending on what it asks to do. To stop it, remove the connection from
          wherever you connected it (for example, your AI tool's connector settings).
        </p>

        <div className="oauth-consent-actions">
          <button
            type="button"
            className="oauth-consent-approve"
            disabled={deciding !== null}
            onClick={() => decide("approve")}
          >
            {deciding === "approve" ? "Connecting…" : `Allow ${details.client.name}`}
          </button>
          <button type="button" className="oauth-consent-deny" disabled={deciding !== null} onClick={() => decide("deny")}>
            {deciding === "deny" ? "Denying…" : "Deny"}
          </button>
        </div>
      </div>
    </div>
  );
}
