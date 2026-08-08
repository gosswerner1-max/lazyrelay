import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { trackSignUp } from "../lib/analytics";

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  signUp: (email: string, password: string, captchaToken: string, businessName?: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string, captchaToken: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

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
    // business_name rides in Supabase's user metadata purely to get it to
    // the handle_new_user() trigger (see migration 0024) — it isn't read
    // back from here, the accounts table is the source of truth afterward.
    const trimmed = businessName?.trim();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { captchaToken, ...(trimmed ? { data: { business_name: trimmed } } : {}) },
    });
    if (!error) trackSignUp();
    return { error: error?.message ?? null };
  };

  const signIn = async (email: string, password: string, captchaToken: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password, options: { captchaToken } });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
