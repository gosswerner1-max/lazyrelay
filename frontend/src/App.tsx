import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { PrivacyPolicy } from "./pages/PrivacyPolicy";
import { TermsOfService } from "./pages/TermsOfService";
import { Contact } from "./pages/Contact";
import { Spinner } from "./components/Spinner";
import "./App.css";

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
