import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { PrivacyPolicy } from "./pages/PrivacyPolicy";
import { TermsOfService } from "./pages/TermsOfService";
import { Contact } from "./pages/Contact";
import { ConnectForm } from "./pages/ConnectForm";
import { Spinner } from "./components/Spinner";
import "./App.css";

const MANUAL_CONNECT_PLATFORMS = ["bluesky", "telegram", "discord"] as const;

type View = "landing" | "signin" | "signup" | "privacy" | "terms" | "contact";

const PATH_TO_VIEW: Record<string, View> = {
  "/terms": "terms",
  "/privacy": "privacy",
  "/contact": "contact",
  "/login": "signin",
  "/signup": "signup",
  "/pricing": "landing",
};

const VIEW_TO_PATH: Partial<Record<View, string>> = {
  landing: "/",
  terms: "/terms",
  privacy: "/privacy",
  contact: "/contact",
  signin: "/login",
  signup: "/signup",
};

function Root() {
  const { session, loading } = useAuth();
  const [view, setView] = useState<View>(() => PATH_TO_VIEW[window.location.pathname] ?? "landing");
  const [initialPath] = useState(() => window.location.pathname);

  useEffect(() => {
    // Connect-form pages own their own URL (/connect/<platform>?state=...)
    // outside this view/path state machine — syncing it back to whatever
    // `view` resolves to (usually "/") would silently strip the `state`
    // query param a moment after landing here, before ConnectForm's own
    // render even gets a chance to read it.
    if (window.location.pathname.startsWith("/connect/")) return;
    window.scrollTo(0, 0);
    const path = VIEW_TO_PATH[view] ?? "/";
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
  }, [view]);

  useEffect(() => {
    if (initialPath === "/pricing" && !loading && !session) {
      document.getElementById("pricing")?.scrollIntoView();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, session]);

  useEffect(() => {
    const onPopState = () => setView(PATH_TO_VIEW[window.location.pathname] ?? "landing");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Connect-form pages (Bluesky/Telegram/Discord's non-OAuth credential
  // collection) must render regardless of auth state — they're reached by
  // redirecting the browser here mid-flow, and identity comes entirely
  // from the one-time `state` token in the URL, not the Supabase session.
  const connectMatch = /^\/connect\/([a-z]+)$/.exec(window.location.pathname);
  if (connectMatch && (MANUAL_CONNECT_PLATFORMS as readonly string[]).includes(connectMatch[1])) {
    const state = new URLSearchParams(window.location.search).get("state");
    if (state) {
      return <ConnectForm platform={connectMatch[1] as (typeof MANUAL_CONNECT_PLATFORMS)[number]} state={state} />;
    }
  }

  if (loading) {
    return (
      <div className="loading">
        <Spinner />
      </div>
    );
  }

  if (session) return <Dashboard />;

  if (view === "privacy") {
    return <PrivacyPolicy onBack={() => setView("landing")} />;
  }

  if (view === "terms") {
    return <TermsOfService onBack={() => setView("landing")} />;
  }

  if (view === "contact") {
    return <Contact onBack={() => setView("landing")} />;
  }

  if (view === "landing") {
    return (
      <Landing
        onSignIn={() => setView("signin")}
        onGetStarted={() => setView("signup")}
        onPrivacy={() => setView("privacy")}
        onTerms={() => setView("terms")}
        onContact={() => setView("contact")}
      />
    );
  }

  return <Login initialMode={view} onBack={() => setView("landing")} />;
}

function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}

export default App;
