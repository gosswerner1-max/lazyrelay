import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import { BrandMark } from "./BrandMark";

// Rendered by App.tsx's Root() when a session exists but its AAL hasn't
// cleared aal2 yet (getAuthenticatorAssuranceLevel().nextLevel !== currentLevel)
// -- i.e. this account has a verified TOTP factor and this particular sign-in
// hasn't completed the second step. On a correct code, mfa.verify() saves a
// new session and fires the MFA_CHALLENGE_VERIFIED auth event, which
// AuthContext's onAuthStateChange listener (it listens to every event) picks
// up and republishes as a new `session` object -- Root() re-runs its own AAL
// check off that same `session` dependency and swaps this screen out for
// Dashboard on its own. So there's nothing to call here after a successful
// verify() beyond letting the promise resolve; no manual redirect/recheck.
export function MfaChallenge() {
  const { signOut } = useAuth();
  const [factorId, setFactorId] = useState<string | null | undefined>(undefined);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.mfa
      .listFactors()
      .then(({ data, error: listError }) => {
        if (cancelled) return;
        if (listError) throw listError;
        setFactorId(data.totp[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setFactorId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code,
      });
      if (verifyError) throw verifyError;
      // Success: onAuthStateChange in AuthContext picks up the refreshed
      // session and Root()'s AAL check lets the dashboard through -- see
      // the comment above the component.
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work. Check the time on your phone and try again.");
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
  }

  return (
    <div className="auth-page auth-page--compact">
      <div className="auth-card">
        <div className="wordmark">
          <BrandMark size={36} />
          <span style={{ fontSize: 22 }}>LazyRelay</span>
        </div>
        <p className="subtitle">Enter your two-factor code</p>
        {factorId === undefined ? (
          <p>Loading...</p>
        ) : factorId === null ? (
          <>
            <p className="error">
              Couldn't find your two-factor setup. Sign out and back in, or contact support if this keeps happening.
            </p>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <label>
              6-digit code from your authenticator app
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                maxLength={6}
                required
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={submitting || code.length !== 6}>
              {submitting ? "..." : "Verify"}
            </button>
          </form>
        )}
        <button className="link" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? "..." : "Sign out"}
        </button>
      </div>
    </div>
  );
}
