import { useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { PrivacyPolicy } from "./pages/PrivacyPolicy";
import { Contact } from "./pages/Contact";
import { Spinner } from "./components/Spinner";
import "./App.css";

function Root() {
  const { session, loading } = useAuth();
  const [view, setView] = useState<"landing" | "signin" | "signup" | "privacy" | "contact">("landing");

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

  if (view === "contact") {
    return <Contact onBack={() => setView("landing")} />;
  }

  if (view === "landing") {
    return (
      <Landing
        onSignIn={() => setView("signin")}
        onGetStarted={() => setView("signup")}
        onPrivacy={() => setView("privacy")}
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
