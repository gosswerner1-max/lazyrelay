import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { PrivacyPolicy } from "./pages/PrivacyPolicy";
import { TermsOfService } from "./pages/TermsOfService";
import { DataDeletion } from "./pages/DataDeletion";
import { Contact } from "./pages/Contact";
import { ApiDocs } from "./pages/ApiDocs";
import { ConnectForm } from "./pages/ConnectForm";
import { BioPage } from "./pages/BioPage";
import { VerifyPage } from "./pages/VerifyPage";
import { Spinner } from "./components/Spinner";
import { CookieConsent } from "./components/CookieConsent";
import "./App.css";

const MANUAL_CONNECT_PLATFORMS = ["bluesky", "telegram", "discord"] as const;

type View = "landing" | "signin" | "signup" | "privacy" | "terms" | "data-deletion" | "contact" | "docs";

const PATH_TO_VIEW: Record<string, View> = {
  "/terms": "terms",
  "/privacy": "privacy",
  "/data-deletion": "data-deletion",
  "/contact": "contact",
  "/docs": "docs",
  "/login": "signin",
  "/signup": "signup",
  "/pricing": "landing",
};

const VIEW_TO_PATH: Partial<Record<View, string>> = {
  landing: "/",
  terms: "/terms",
  privacy: "/privacy",
  "data-deletion": "/data-deletion",
  contact: "/contact",
  docs: "/docs",
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
    // Bio pages (/bio/<slug>) are the same shape of exception — they own
    // their own URL and render entirely outside this view/path state
    // machine, so syncing back to `view`'s resolved path (usually "/")
    // would silently rewrite the URL out from under the page a moment
    // after landing here.
    if (window.location.pathname.startsWith("/bio/")) return;
    // Proof-of-Publish share links are the same shape of exception — a
    // public page a customer shares outside the app, owning its own URL.
    if (window.location.pathname.startsWith("/verify/")) return;
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

  // Public link-in-bio pages (/bio/<slug>) must render regardless of auth
  // state, same reasoning as the connect-form pages above — this is a page
  // for the CUSTOMER's OWN followers to view, not something behind a login.
  const bioMatch = /^\/bio\/([a-z0-9-]{3,40})$/.exec(window.location.pathname);
  if (bioMatch) {
    return <BioPage slug={bioMatch[1]} />;
  }

  // Public Proof-of-Publish verification pages (/verify/<post_results.id>)
  // — same reasoning as bio pages above, must render regardless of auth
  // state since this is a link a customer shares with someone outside
  // LazyRelay entirely (a client, franchise, compliance need).
  const verifyMatch = /^\/verify\/([0-9a-fA-F-]{36})$/.exec(window.location.pathname);
  if (verifyMatch) {
    return <VerifyPage id={verifyMatch[1]} />;
  }

  // Docs must also render regardless of auth state — it's linked directly
  // from inside the authenticated dashboard's API Keys section (opened in
  // a new tab), and Supabase's session persists across tabs of the same
  // origin, so without this check `if (session) return <Dashboard />`
  // below would win every time and a logged-in customer could never
  // actually see this page short of logging out first.
  //
  // Because this check re-runs on every render (not just at mount, unlike
  // the view-state-machine branches below), "Back to home" previously only
  // called setView("landing") -- which never changes window.location, so
  // this same check kept matching and the button did nothing. Found live
  // by Werner, 2026-08-10. Fix: actually update the URL first, so this
  // check stops matching on the next render and the normal view-based
  // logic below takes over correctly.
  if (window.location.pathname === "/docs") {
    return (
      <ApiDocs
        onBack={() => {
          window.history.pushState({}, "", "/");
          setView("landing");
        }}
      />
    );
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

  if (view === "data-deletion") {
    return <DataDeletion onBack={() => setView("landing")} />;
  }

  if (view === "contact") {
    return <Contact onBack={() => setView("landing")} />;
  }

  if (view === "docs") {
    return <ApiDocs onBack={() => setView("landing")} />;
  }

  if (view === "landing") {
    return (
      <Landing
        onSignIn={() => setView("signin")}
        onGetStarted={() => setView("signup")}
        onPrivacy={() => setView("privacy")}
        onTerms={() => setView("terms")}
        onContact={() => setView("contact")}
        onDocs={() => setView("docs")}
      />
    );
  }

  return <Login initialMode={view} onBack={() => setView("landing")} />;
}

function App() {
  return (
    <AuthProvider>
      <Root />
      <CookieConsent />
    </AuthProvider>
  );
}

export default App;
