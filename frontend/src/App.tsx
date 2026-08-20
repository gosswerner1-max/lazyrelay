import { useEffect, useState, lazy, Suspense } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { supabase } from "./lib/supabase";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { PrivacyPolicy } from "./pages/PrivacyPolicy";
import { TermsOfService } from "./pages/TermsOfService";
import { DPA } from "./pages/DPA";
import { DataDeletion } from "./pages/DataDeletion";
import { Contact } from "./pages/Contact";
import { ConnectForm } from "./pages/ConnectForm";
import { BioPage } from "./pages/BioPage";
import { VerifyPage } from "./pages/VerifyPage";
import { OAuthConsentPage } from "./pages/OAuthConsent";
import { TeamAcceptInvitePage } from "./pages/TeamAcceptInvite";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { Spinner } from "./components/Spinner";
import { CookieConsent } from "./components/CookieConsent";
import "./App.css";

// Lazy-loaded (2026-08-20) — by far the two biggest chunks in the app
// (Dashboard pulls in every tab's components: Charts, AccountPicker,
// MediaStorageList, DateTimePicker...; ApiDocs is a full static reference
// page). A brand-new visitor hitting the landing page from an ad — the
// exact traffic a launch sends — never needs either until they actually
// sign in or click through to /docs, so there's no reason to make them
// download that code up front.
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const ApiDocs = lazy(() => import("./pages/ApiDocs").then((m) => ({ default: m.ApiDocs })));

const MANUAL_CONNECT_PLATFORMS = ["bluesky", "telegram", "discord"] as const;

// Captured once at module-evaluation time, before React (or any of its
// effects) runs at all. Root's own path-sync effect rewrites the URL back
// to "/" almost immediately for any path that maps to the "landing" view
// (which /pricing does) -- reading window.location.pathname live from
// inside a later effect/layoutEffect would already see "/", not
// "/pricing". This constant is the only reliable way to know what the
// visitor actually navigated to.
const INITIAL_PATH = window.location.pathname;

type View = "landing" | "signin" | "signup" | "privacy" | "terms" | "dpa" | "data-deletion" | "contact" | "docs" | "forgot-password";

const PATH_TO_VIEW: Record<string, View> = {
  "/terms": "terms",
  "/privacy": "privacy",
  "/dpa": "dpa",
  "/data-deletion": "data-deletion",
  "/contact": "contact",
  "/docs": "docs",
  "/login": "signin",
  "/signup": "signup",
  "/pricing": "landing",
  "/forgot-password": "forgot-password",
};

const VIEW_TO_PATH: Partial<Record<View, string>> = {
  landing: "/",
  terms: "/terms",
  privacy: "/privacy",
  dpa: "/dpa",
  "data-deletion": "/data-deletion",
  contact: "/contact",
  docs: "/docs",
  signin: "/login",
  signup: "/signup",
};

// Supabase redirects an expired/invalid/already-used auth link (email
// confirm, magic link, invite) back to the Site URL with error details in
// the URL *hash*, not a query string — found live 2026-08-20 when an old
// confirmation link landed on lazyrelay.com showing
// "#error=access_denied&error_code=otp_expired&..." with nothing on screen
// explaining it, just the plain landing page under a broken-looking URL.
// Read once at module-evaluation time for the same reason INITIAL_PATH is.
function parseAuthHashError(): { code: string; description: string } | null {
  if (!window.location.hash.includes("error=")) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const error = params.get("error");
  if (!error) return null;
  return {
    code: params.get("error_code") ?? error,
    description: (params.get("error_description") ?? "That link didn't work.").replace(/\+/g, " "),
  };
}
const INITIAL_AUTH_HASH_ERROR = parseAuthHashError();

function Root() {
  const { session, loading } = useAuth();
  const [view, setView] = useState<View>(() => PATH_TO_VIEW[window.location.pathname] ?? "landing");
  // Catches the case where the recovery email link lands on the site root
  // instead of /reset-password (Supabase may redirect to Site URL when the
  // email template doesn't preserve the redirectTo path). Listening for the
  // PASSWORD_RECOVERY auth event is the only reliable signal regardless of
  // where the link actually lands.
  const [resetMode, setResetMode] = useState(window.location.pathname === "/reset-password");
  const [authHashError, setAuthHashError] = useState(INITIAL_AUTH_HASH_ERROR);

  // Strips the error hash out of the URL bar once read, so it doesn't sit
  // there looking broken (or get re-parsed as a "new" error on a later
  // re-render) — same one-time-read intent as INITIAL_PATH/INITIAL_AUTH_HASH_ERROR.
  useEffect(() => {
    if (authHashError) {
      window.history.replaceState({}, "", window.location.pathname + window.location.search);
    }
  }, []);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setResetMode(true);
        window.history.pushState({}, "", "/reset-password");
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

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
    // The OAuth consent screen is the same shape of exception too — it owns
    // its own URL (with an authorization_id query param this effect would
    // otherwise strip). Missing this exclusion was caught live: without it,
    // this effect rewrites the URL to "/" via pushState before the page
    // ever settles (view defaults to "landing" since /oauth/consent isn't
    // in PATH_TO_VIEW), and React 18 StrictMode's dev-only double-render
    // then re-evaluates the path check against the now-rewritten URL,
    // silently swapping the whole page back to Landing.
    if (window.location.pathname === "/oauth/consent") return;
    // Same exception, same reason — /team/accept?token=... owns its own URL
    // and needs the token query param to survive past the first render.
    if (window.location.pathname === "/team/accept") return;
    window.scrollTo(0, 0);
    const path = VIEW_TO_PATH[view] ?? "/";
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
  }, [view]);

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

  // OAuth consent screen (/oauth/consent?authorization_id=...) — configured
  // in the Supabase dashboard as this project's OAuth Server Authorization
  // Path. Reached mid-flow when an AI agent asks to connect to a customer's
  // LazyRelay account via the hosted MCP server. Same shape of exception as
  // /connect/, /bio/ and /verify/ above: it owns its own URL and (unlike
  // those three) does need the normal auth state, which OAuthConsentPage
  // handles internally via useAuth() rather than the session gate below,
  // since "not signed in yet" is itself a real, expected state here.
  if (window.location.pathname === "/oauth/consent") {
    const authorizationId = new URLSearchParams(window.location.search).get("authorization_id");
    return <OAuthConsentPage authorizationId={authorizationId} />;
  }

  // Team invite acceptance (/team/accept?token=...) — same shape of
  // exception as OAuth consent above, and for the same reason: it needs the
  // normal auth state (sign in first if needed) rather than the plain
  // session gate below, since "not signed in yet" is expected here too.
  if (window.location.pathname === "/team/accept") {
    const token = new URLSearchParams(window.location.search).get("token");
    return <TeamAcceptInvitePage token={token} />;
  }

  // Reset-password page must render before the session check. resetMode is
  // set either by the URL path (direct navigation) or by the PASSWORD_RECOVERY
  // auth event (recovery email landed on site root instead of /reset-password).
  if (resetMode) {
    return <ResetPassword />;
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

  if (view === "dpa") {
    return <DPA onBack={() => setView("landing")} />;
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

  if (view === "forgot-password") {
    return <ForgotPassword onBack={() => setView("signin")} />;
  }

  // The only two views a stray auth-error hash can realistically land on —
  // any other branch above returns before reaching here, and none of them
  // are where an email link would ever point.
  const authErrorBanner = authHashError && (
    <div className="auth-hash-error-banner">
      <span>
        {authHashError.code === "otp_expired"
          ? "That link has expired. Please sign up again to get a new confirmation email."
          : `That link didn't work (${authHashError.description}). Please try again, or contact support if it keeps happening.`}
      </span>
      <button type="button" onClick={() => setAuthHashError(null)} aria-label="Dismiss">
        &times;
      </button>
    </div>
  );

  if (view === "landing") {
    return (
      <>
        {authErrorBanner}
        <Landing
          onSignIn={() => setView("signin")}
          onGetStarted={() => setView("signup")}
          onPrivacy={() => setView("privacy")}
          onTerms={() => setView("terms")}
          onDpa={() => setView("dpa")}
          onContact={() => setView("contact")}
          onDocs={() => setView("docs")}
          scrollToPricing={INITIAL_PATH === "/pricing"}
        />
      </>
    );
  }

  return (
    <>
      {authErrorBanner}
      <Login initialMode={view} onBack={() => setView("landing")} onForgotPassword={() => setView("forgot-password")} />
    </>
  );
}

function App() {
  return (
    <AuthProvider>
      <Suspense
        fallback={
          <div className="loading">
            <Spinner />
          </div>
        }
      >
        <Root />
      </Suspense>
      <CookieConsent />
    </AuthProvider>
  );
}

export default App;
