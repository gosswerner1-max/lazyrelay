import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { trackSignUp } from "../lib/analytics";
import { getStoredReferralCode } from "../lib/referral";

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  signUp: (email: string, password: string, captchaToken: string, businessName?: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string, captchaToken: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Supabase's own default storage key, derived the same way its client does
// internally (sb-<project-ref>-auth-token) -- reading it directly here,
// synchronously, is what lets a genuinely logged-out first paint skip the
// loading spinner entirely instead of always showing it while
// getSession() resolves. That matters specifically for the prerendered
// homepage: the static snapshot IS the logged-out Landing page, so the
// real first client render must produce that same page immediately, not a
// spinner, or hydration mismatches and the visitor sees a flash. A stored
// token still falls through to the normal loading-then-verify path below
// unchanged -- this only short-circuits the case where there's plainly
// nothing to check.
function hasStoredSessionToken(): boolean {
  try {
    const url = import.meta.env.VITE_SUPABASE_URL as string;
    const key = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
    return localStorage.getItem(key) !== null;
  } catch {
    // Any failure here (private browsing, malformed env var) should fall
    // back to the always-safe original behavior, not a false "logged out".
    return true;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(hasStoredSessionToken);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, captchaToken: string, businessName?: string) => {
    // business_name and referred_by_code both ride in Supabase's user
    // metadata purely to get them to the handle_new_user() trigger (see
    // migration 0024 for business_name, 0079 for referred_by_code) — neither
    // is read back from here, the accounts table is the source of truth
    // afterward. The referral code (if any) was captured on an earlier page
    // load by App.tsx/lib/referral.ts, not read fresh from the URL here —
    // this is the signup form, which doesn't carry a `?ref=` param itself.
    const trimmed = businessName?.trim();
    const referredByCode = getStoredReferralCode();
    const metadata = {
      ...(trimmed ? { business_name: trimmed } : {}),
      ...(referredByCode ? { referred_by_code: referredByCode } : {}),
    };
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { captchaToken, ...(Object.keys(metadata).length > 0 ? { data: metadata } : {}) },
    });
    if (!error) trackSignUp();
    return { error: error?.message ?? null };
  };

  const signIn = async (email: string, password: string, captchaToken: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password, options: { captchaToken } });
    return { error: error?.message ?? null };
  };

  // Google's own consent flow replaces Turnstile as the bot check here --
  // no captcha token to thread through. onAuthStateChange (above) picks up
  // the resulting session once Google redirects back through Supabase's
  // callback, same as every other auth path in this file.
  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, loading, signUp, signIn, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
