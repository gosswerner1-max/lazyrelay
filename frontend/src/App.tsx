import { AuthProvider, useAuth } from "./context/AuthContext";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import "./App.css";

function Root() {
  const { session, loading } = useAuth();

  if (loading) return <p className="loading">Loading...</p>;
  return session ? <Dashboard /> : <Login />;
}

function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}

export default App;
