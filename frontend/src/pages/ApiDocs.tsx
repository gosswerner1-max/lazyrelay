import { BrandMark } from "../components/BrandMark";

interface ApiDocsProps {
  onBack: () => void;
}

const ENDPOINTS = [
  {
    method: "GET",
    path: "/social-accounts",
    summary: "List your connected social accounts",
    body: null,
  },
  {
    method: "POST",
    path: "/scheduled-posts",
    summary: "Schedule a post to one connected account",
    body: `{
  "socialAccountId": "…",
  "content": "Your post text",
  "scheduledFor": "2026-08-10T09:00:00Z",
  "mediaUrl": "https://example.com/image.jpg"
}`,
  },
  {
    method: "GET",
    path: "/scheduled-posts",
    summary: "List upcoming and recent posts, with status and Proof-of-Publish verification",
    body: null,
  },
  {
    method: "DELETE",
    path: "/scheduled-posts/:id",
    summary: "Cancel a pending post",
    body: null,
  },
  {
    method: "GET",
    path: "/analytics/summary?days=30",
    summary: "Post counts, verified-live rate, per-platform breakdown, engagement totals",
    body: null,
  },
  {
    method: "GET",
    path: "/mentions",
    summary: "Recent comments on your posts, where the platform supports reading them",
    body: null,
  },
  {
    method: "POST",
    path: "/mentions/reply",
    summary: "Reply to a comment surfaced by GET /mentions",
    body: `{
  "postId": "…",
  "commentId": "…",
  "text": "Thanks so much!"
}`,
  },
];

export function ApiDocs({ onBack }: ApiDocsProps) {
  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="wordmark">
          <BrandMark size={28} />
          <span>LazyRelay</span>
        </div>
        <nav className="landing-nav-links">
          <button className="link" onClick={onBack}>
            &larr; Back to home
          </button>
        </nav>
      </header>

      <section className="landing-section legal-page api-docs">
        <h2>API &amp; MCP server</h2>
        <p className="section-note">
          Everything below is real and live today — the same API LazyRelay's own dashboard runs on.
        </p>

        <div className="legal-body">
          <h3>Authentication</h3>
          <p>
            Generate a key from your dashboard: <strong>Settings → More → API Keys → Create key</strong>. The raw
            key is shown once — copy it immediately. Send it as a bearer token on every request:
          </p>
          <pre className="api-code-block">
            <code>Authorization: Bearer lzr_live_your_key_here</code>
          </pre>
          <p>
            Each key acts as your account — treat it like a password. Creating or revoking keys always requires
            signing in to the dashboard directly; a key can never be used to mint or revoke other keys, so a
            leaked key can't lock you out.
          </p>

          <h3>Base URL</h3>
          <pre className="api-code-block">
            <code>https://lazyrelaylazyrelay-backend.onrender.com/api</code>
          </pre>

          <h3>Endpoints</h3>
          <div className="api-endpoint-list">
            {ENDPOINTS.map((e) => (
              <div className="api-endpoint" key={`${e.method} ${e.path}`}>
                <div className="api-endpoint-header">
                  <span className={`api-method api-method-${e.method.toLowerCase()}`}>{e.method}</span>
                  <code>{e.path}</code>
                </div>
                <p>{e.summary}</p>
                {e.body && (
                  <pre className="api-code-block">
                    <code>{e.body}</code>
                  </pre>
                )}
              </div>
            ))}
          </div>

          <h3>Using this from an AI agent — the MCP server</h3>
          <p>
            If you're connecting an AI agent (Claude Desktop, Claude Code, Cursor, or anything else that speaks
            MCP) rather than writing HTTP calls by hand, use LazyRelay's own MCP server instead of calling the
            API directly — it wraps every endpoint above as a real tool the agent can call.
          </p>
          <pre className="api-code-block">
            <code>{`{
  "mcpServers": {
    "lazyrelay": {
      "command": "npx",
      "args": ["-y", "@lazyrelay/mcp-server"],
      "env": { "LAZYRELAY_API_KEY": "lzr_live_your_key_here" }
    }
  }
}`}</code>
          </pre>
          <p>
            This runs locally on your own machine using your own API key — there's nothing to host. See the
            package README for the full tool list.
          </p>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="wordmark">
          <BrandMark size={22} />
          <span>LazyRelay</span>
        </div>
        <p>&copy; {new Date().getFullYear()} LazyRelay. All rights reserved.</p>
      </footer>
    </div>
  );
}
