import { useState, type FormEvent } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import { supabase } from "../lib/supabase";
import { BrandMark } from "../components/BrandMark";

interface ForgotPasswordProps {
  onBack: () => void;
}

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

export function ForgotPassword({ onBack }: ForgotPasswordProps) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [widgetKey, setWidgetKey] = useState(0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!captchaToken) {
      setError("Please complete the verification check.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
      captchaToken,
    });
    setSubmitting(false);
    setCaptchaToken(null);
    setWidgetKey((k) => k + 1);
    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }
  }

  return (
    <div className="auth-page auth-page--compact">
      {sent ? (
        <div className="auth-card">
          <BrandMark size={40} />
          <h1>Check your email</h1>
          <p>We sent a password reset link to {email}. Click it to set a new password.</p>
          <button onClick={onBack}>Back to sign in</button>
        </div>
      ) : (
        <div className="auth-card">
          <div className="wordmark">
            <BrandMark size={36} />
            <span style={{ fontSize: 22 }}>LazyRelay</span>
          </div>
          <p className="subtitle">Reset your password</p>
          <form onSubmit={handleSubmit}>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </label>
            {TURNSTILE_SITE_KEY && (
              <Turnstile
                key={widgetKey}
                siteKey={TURNSTILE_SITE_KEY}
                onSuccess={setCaptchaToken}
                onExpire={() => setCaptchaToken(null)}
                onError={() => setCaptchaToken(null)}
              />
            )}
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={submitting || !email.trim() || !captchaToken}>
              {submitting ? "Sending..." : "Send reset link"}
            </button>
          </form>
          <button className="link" onClick={onBack}>
            &larr; Back to sign in
          </button>
        </div>
      )}
    </div>
  );
}
