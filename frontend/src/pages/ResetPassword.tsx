import { useState, useEffect, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { BrandMark } from "../components/BrandMark";

export function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Supabase processes the recovery token from the URL hash and fires
  // PASSWORD_RECOVERY once the session is established. Only show the form
  // after that event so updateUser() has a valid session to act on.
  // Also handle the race where the event fires before the listener is
  // registered — getSession() catches that case.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (error) {
      setError(error.message);
    } else {
      setDone(true);
      setTimeout(() => {
        window.history.pushState({}, "", "/");
        window.location.reload();
      }, 1500);
    }
  }

  return (
    <div className="auth-page auth-page--compact">
      <div className="auth-card">
        <div className="wordmark">
          <BrandMark size={36} />
          <span style={{ fontSize: 22 }}>LazyRelay</span>
        </div>
        {done ? (
          <p className="subtitle">Password updated — signing you in...</p>
        ) : !ready ? (
          <p className="subtitle">Verifying your reset link...</p>
        ) : (
          <>
            <p className="subtitle">Choose a new password</p>
            <form onSubmit={handleSubmit}>
              <label>
                New password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={6}
                  required
                  autoFocus
                />
              </label>
              <label>
                Confirm password
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </label>
              {error && <p className="error">{error}</p>}
              <button type="submit" disabled={submitting || !password || !confirm}>
                {submitting ? "Saving..." : "Set new password"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
