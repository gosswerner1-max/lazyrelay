import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/** Real gap found in the 2026-08-25 pre-launch audit: nothing in the app
 *  caught a render-time exception, so any uncaught error anywhere in
 *  Dashboard/Login/etc. blanked the entire page to white with zero
 *  explanation — the worst possible failure mode for a paying customer.
 *  Deliberately styled with plain inline styles referencing only the
 *  global CSS custom properties (set in index.css, loaded before this can
 *  ever render) rather than any component-level class — an error boundary
 *  that itself depends on app state/CSS that might be part of what broke
 *  is not a safe fallback. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught render error:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "2rem",
          background: "var(--paper, #f5f6f8)",
          color: "var(--ink, #14171f)",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>Something went wrong</h1>
        <p style={{ color: "var(--wire, #5b6472)", marginBottom: "1.5rem", maxWidth: "28rem" }}>
          This page hit an unexpected error. Refreshing usually fixes it — if it keeps happening, contact
          support@lazyrelay.com.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            background: "var(--signal-solid, #c82400)",
            color: "#fff",
            border: "none",
            borderRadius: "0.5rem",
            padding: "0.75rem 1.5rem",
            fontSize: "1rem",
            cursor: "pointer",
          }}
        >
          Refresh page
        </button>
      </div>
    );
  }
}
