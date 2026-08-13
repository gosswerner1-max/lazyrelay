import { useState, type FormEvent } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import { useAuth } from "../context/AuthContext";
import { BrandMark } from "../components/BrandMark";

interface LoginProps {
  initialMode?: "signin" | "signup";
  onBack: () => void;
  onForgotPassword?: () => void;
}

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

export function Login({ initialMode = "signin", onBack, onForgotPassword }: LoginProps) {
  const { signIn, signUp } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signedUp, setSignedUp] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  // Turnstile tokens are single-use — bumping this key remounts the widget
  // so a retry (after a failed attempt, or switching signin/signup) gets a
  // fresh token instead of replaying an already-spent one.
  const [widgetKey, setWidgetKey] = useState(0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!captchaToken) {
      setError("Please complete the verification check.");
      return;
    }
    setSubmitting(true);
    const result =
      mode === "signin" ? await signIn(email, password, captchaToken) : await signUp(email, password, captchaToken, businessName);
    setSubmitting(false);
    setCaptchaToken(null);
    setWidgetKey((k) => k + 1);
    if (result.error) {
      setError(result.error);
    } else if (mode === "signup") {
      setSignedUp(true);
    }
  }

  return (
    <div className="auth-page auth-page--compact">
      {signedUp ? (
        <div className="auth-card">
          <BrandMark size={40} />
          <h1>Check your email</h1>
          <p>We sent a confirmation link to {email}. Confirm it, then come back and sign in.</p>
          <button onClick={() => { setSignedUp(false); setMode("signin"); }}>Back to sign in</button>
        </div>
      ) : (
        <div className="auth-card">
          <div className="wordmark">
            <BrandMark size={36} />
            <span style={{ fontSize: 22 }}>LazyRelay</span>
          </div>
          <p className="subtitle">{mode === "signin" ? "Sign in to your account" : "Create your account"}</p>
          <form onSubmit={handleSubmit}>
            {mode === "signup" && (
              <label>
                What should we call you?
                <input
                  type="text"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="Your business or brand name"
                  maxLength={80}
                />
              </label>
            )}
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
                required
              />
            </label>
            {mode === "signin" && onForgotPassword && (
              <button type="button" className="link" style={{ fontSize: "0.82em", textAlign: "right", marginTop: "-0.25rem" }} onClick={onForgotPassword}>
                Forgot password?
              </button>
            )}
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
            <button type="submit" disabled={submitting || !captchaToken}>
              {submitting ? "..." : mode === "signin" ? "Sign in" : "Sign up"}
            </button>
          </form>
          <button
            className="link"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setCaptchaToken(null);
              setWidgetKey((k) => k + 1);
            }}
          >
            {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
          </button>
        </div>
      )}
      <button className="link" onClick={onBack}>
        &larr; Back to home
      </button>
    </div>
  );
}
