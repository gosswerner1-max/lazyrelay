import { BrandMark } from "../components/BrandMark";
import { CodeBlock } from "../components/CodeBlock";
import { API_BASE_URL, API_ENDPOINTS, MCP_CONFIG_EXAMPLE } from "../lib/apiDocsContent";

interface ApiDocsProps {
  onBack: () => void;
}

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
          Everything below is real and live today — the same API LazyRelay's own dashboard runs on. Already have
          an account? The same docs live inside your dashboard's API Keys tab, with no need to sign back in.
        </p>

        <div className="legal-body">
          <h3>Authentication</h3>
          <p>
            Generate a key from your dashboard: <strong>Settings → More → API Keys → Create key</strong>. The raw
            key is shown once — copy it immediately. Send it as a bearer token on every request:
          </p>
          <CodeBlock code="Authorization: Bearer lzr_live_your_key_here" />
          <p>
            Each key acts as your account — treat it like a password. Creating or revoking keys always requires
            signing in to the dashboard directly; a key can never be used to mint or revoke other keys, so a
            leaked key can't lock you out.
          </p>

          <h3>Base URL</h3>
          <CodeBlock code={API_BASE_URL} />

          <h3>Endpoints</h3>
          <div className="api-endpoint-list">
            {API_ENDPOINTS.map((e) => (
              <div className="api-endpoint" key={`${e.method} ${e.path}`}>
                <div className="api-endpoint-header">
                  <span className={`api-method api-method-${e.method.toLowerCase()}`}>{e.method}</span>
                  <code>{e.path}</code>
                </div>
                <p>{e.summary}</p>
                {e.body && <CodeBlock code={e.body} />}
              </div>
            ))}
          </div>

          <h3>Using this from an AI agent — the MCP server</h3>
          <p>
            If you're connecting an AI agent (Claude Desktop, Claude Code, Cursor, or anything else that speaks
            MCP) rather than writing HTTP calls by hand, use LazyRelay's own MCP server instead of calling the
            API directly — it wraps every endpoint above as a real tool the agent can call.
          </p>
          <CodeBlock code={MCP_CONFIG_EXAMPLE} />
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
