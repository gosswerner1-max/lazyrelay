import { useEffect, useRef, useState, type FormEvent } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import { useAuth } from "../context/AuthContext";
import { BrandMark } from "../components/BrandMark";
import { useCanonical } from "../lib/useCanonical";
import { api } from "../lib/api";

interface LoginProps {
  initialMode?: "signin" | "signup";
  onBack: () => void;
  onForgotPassword?: () => void;
}

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

export function Login({ initialMode = "signin", onBack, onForgotPassword }: LoginProps) {
  const { signIn, signUp, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [nameStatus, setNameStatus] = useState<"idle" | "checking" | "available" | "taken">("idle");
  const [nameSuggestions, setNameSuggestions] = useState<string[]>([]);
  const nameCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [signedUp, setSignedUp] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  // Turnstile tokens are single-use — bumping this key remounts the widget
  // so a retry (after a failed attempt, or switching signin/signup) gets a
  // fresh token instead of replaying an already-spent one.
  const [widgetKey, setWidgetKey] = useState(0);

  useEffect(() => {
    const previous = document.title;
    document.title = mode === "signup" ? "Sign Up | LazyRelay" : "Log In | LazyRelay";
    return () => {
      document.title = previous;
    };
  }, [mode]);
  useCanonical(mode === "signup" ? "/signup" : "/login");

  // Checks as the customer types so a taken name surfaces before they hit
  // submit, with a few free alternatives to pick from (2026-08-30) --
  // duplicate business names make it slower for support to find the right
  // account when several customers share a common one. This is a
  // convenience nudge only; migration 0074's unique index is the real
  // backstop if this check fails to run or two people submit the same
  // name in the same instant.
  useEffect(() => {
    if (mode !== "signup") return;
    const trimmed = businessName.trim();
    if (!trimmed) {
      setNameStatus("idle");
      setNameSuggestions([]);
      return;
    }
    setNameStatus("checking");
    if (nameCheckTimer.current) clearTimeout(nameCheckTimer.current);
    nameCheckTimer.current = setTimeout(async () => {
      try {
        const result = await api.checkBusinessNameAvailability(trimmed);
        setNameStatus(result.available ? "available" : "taken");
        setNameSuggestions(result.available ? [] : (result.suggestions ?? []));
      } catch {
        setNameStatus("idle");
        setNameSuggestions([]);
      }
    }, 500);
    return () => {
      if (nameCheckTimer.current) clearTimeout(nameCheckTimer.current);
    };
  }, [businessName, mode]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!captchaToken) {
      setError("Please complete the verification check.");
      return;
    }
    const trimmedName = businessName.trim();
    if (mode === "signup" && trimmedName) {
      if (nameStatus === "taken") {
        setError("That business name is already taken — pick one of the suggestions or a different name.");
        return;
      }
      if (nameStatus !== "available") {
        // The debounce may not have resolved yet on a fast submit.
        try {
          const result = await api.checkBusinessNameAvailability(trimmedName);
          if (!result.available) {
            setNameStatus("taken");
            setNameSuggestions(result.suggestions ?? []);
            setError("That business name is already taken — pick one of the suggestions or a different name.");
            return;
          }
        } catch {
          // Don't block signup on a check that itself failed to run.
        }
      }
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

  async function handleGoogle() {
    setError(null);
    setGoogleSubmitting(true);
    // Redirects away immediately on success -- Google's own consent screen
    // takes over the tab, so there's no "submitting" state to clear on the
    // happy path, only on a real failure to even start the redirect.
    const result = await signInWithGoogle();
    if (result.error) {
      setError(result.error);
      setGoogleSubmitting(false);
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
          <button type="button" className="oauth-google-button" onClick={handleGoogle} disabled={googleSubmitting}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.87 2.69-6.62z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.85.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
              <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.69 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
            </svg>
            {googleSubmitting ? "..." : "Continue with Google"}
          </button>
          <div className="oauth-divider">
            <span>or</span>
          </div>
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
            {mode === "signup" && nameStatus === "checking" && <p className="field-hint">Checking availability...</p>}
            {mode === "signup" && nameStatus === "available" && (
              <p className="field-hint field-hint--ok">Available</p>
            )}
            {mode === "signup" && nameStatus === "taken" && (
              <div className="field-hint field-hint--error">
                <p>That name's taken{nameSuggestions.length > 0 ? " — try:" : "."}</p>
                {nameSuggestions.length > 0 && (
                  <div className="name-suggestions">
                    {nameSuggestions.map((suggestion) => (
                      <button
                        type="button"
                        key={suggestion}
                        className="name-suggestion-chip"
                        onClick={() => {
                          setBusinessName(suggestion);
                          setNameStatus("available");
                          setNameSuggestions([]);
                        }}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}
              </div>
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
