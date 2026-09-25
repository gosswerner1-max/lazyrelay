// The "API Keys" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { describeScopes } from "../../lib/oauthScopes";
import { API_BASE_URL, API_ENDPOINTS, MCP_CONFIG_EXAMPLE, HOSTED_MCP_URL, HOSTED_MCP_REMOTE_CONFIG_EXAMPLE, MCP_TOOLS } from "../../lib/apiDocsContent";
import { CodeBlock } from "../../components/CodeBlock";
import { useDashboard } from "./DashboardContext";

export function ApiKeysTab() {
  const {
    apiKeys,
    apiKeyName,
    setApiKeyName,
    apiKeyCanShareProof,
    setApiKeyCanShareProof,
    creatingKey,
    newlyCreatedKey,
    setNewlyCreatedKey,
    revokingKeyId,
    showRevokedKeys,
    setShowRevokedKeys,
    oauthGrants,
    oauthGrantsLoading,
    revokingGrantClientId,
    handleCreateApiKey,
    handleRevokeApiKey,
    handleRevokeGrant,
  } = useDashboard();

  return (
    <>
      {(
      <section>
        <h2>API keys</h2>
        <p className="section-note">
          Let your own AI agent post and schedule directly through LazyRelay's API, without a browser or a human
          login. Full reference below.
        </p>
        <a href="/docs" target="_blank" rel="noopener noreferrer" className="btn-outline api-docs-open-button">
          Open API &amp; MCP docs as its own page (to share with a developer)
        </a>
        <p className="security-notice">
          <span aria-hidden="true">⚠️</span>
          <span>
            Treat every key like a password. Anyone who has it can post, schedule, and manage this account exactly
            as you can. Never share a key or commit one to code. Revoke it immediately if you think it's leaked.
          </span>
        </p>
        {newlyCreatedKey && (
          <div className="api-key-reveal">
            <p><strong>Copy this key now</strong>, it won't be shown again.</p>
            <CodeBlock code={newlyCreatedKey} sensitive />
            <button type="button" className="btn-outline" onClick={() => setNewlyCreatedKey(null)}>
              Done
            </button>
          </div>
        )}
        <form onSubmit={handleCreateApiKey} className="api-key-form">
          <input
            type="text"
            value={apiKeyName}
            onChange={(e) => setApiKeyName(e.target.value)}
            placeholder="Key name (e.g. Posting agent)"
            maxLength={60}
          />
          <label className="api-key-share-proof-toggle">
            <input
              type="checkbox"
              checked={apiKeyCanShareProof}
              onChange={(e) => setApiKeyCanShareProof(e.target.checked)}
            />
            Allow this key to generate public proof-sharing links
          </label>
          <div className="api-key-form-submit-row">
            <button type="submit" className="btn-primary" disabled={creatingKey || !apiKeyName.trim()}>
              {creatingKey ? "Creating..." : "Create key"}
            </button>
          </div>
        </form>
        {apiKeys.length === 0 ? (
          <p className="empty">No API keys yet.</p>
        ) : (
          <>
            {(() => {
              const activeKeys = apiKeys.filter((k) => !k.revoked_at);
              const revokedKeys = apiKeys.filter((k) => k.revoked_at);
              return (
                <>
                  {activeKeys.length === 0 ? (
                    <p className="empty">No active API keys.</p>
                  ) : (
                    <ul className="media-list">
                      {activeKeys.map((k) => (
                        <li key={k.id}>
                          <span className="media-list-meta">
                            <strong>{k.name}</strong>: {k.key_prefix}...
                            <span className="status-badge status-active">
                              {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleDateString()}` : "never used"}
                            </span>
                            {k.can_share_proof && (
                              <span className="status-badge status-active">can share proof links</span>
                            )}
                          </span>
                          <button
                            className="btn-outline"
                            onClick={() => handleRevokeApiKey(k.id)}
                            disabled={revokingKeyId !== null}
                          >
                            {revokingKeyId === k.id ? "Revoking..." : "Revoke"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {revokedKeys.length > 0 && (
                    <>
                      <button type="button" className="link-button" onClick={() => setShowRevokedKeys((v) => !v)}>
                        {showRevokedKeys ? "Hide" : "Show"} {revokedKeys.length} revoked key{revokedKeys.length === 1 ? "" : "s"}
                      </button>
                      {showRevokedKeys && (
                        <ul className="media-list">
                          {revokedKeys.map((k) => (
                            <li key={k.id}>
                              <span className="media-list-meta">
                                <strong>{k.name}</strong>: {k.key_prefix}...
                                <span className="status-badge status-cancelled">revoked</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </>
              );
            })()}
          </>
        )}
      </section>
      )}

      {(
      <section>
        <h2>Connected apps</h2>
        <p className="section-note">
          Apps you've signed in and given access to via the hosted MCP server, like Claude connecting through{" "}
          <code>{HOSTED_MCP_URL}</code>. Unlike an API key above, these don't use a key you generate, they use your
          LazyRelay login directly.
        </p>
        {oauthGrantsLoading ? (
          <p className="empty">Loading…</p>
        ) : oauthGrants.length === 0 ? (
          <p className="empty">No connected apps yet.</p>
        ) : (
          <ul className="media-list">
            {oauthGrants.map((g) => (
              <li key={g.client.id}>
                <span className="media-list-meta">
                  <strong>{g.client.name}</strong>: connected {new Date(g.granted_at).toLocaleDateString()}
                  <span style={{ display: "block", fontSize: 12, color: "var(--wire)" }}>
                    Can: {describeScopes(g.scopes).join(", ")}
                  </span>
                </span>
                <button
                  className="btn-outline"
                  onClick={() => handleRevokeGrant(g.client.id, g.client.name)}
                  disabled={revokingGrantClientId !== null}
                >
                  {revokingGrantClientId === g.client.id ? "Disconnecting..." : "Disconnect"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      {(
      <section>
        <h2>API reference</h2>
        <p className="section-note">
          Send your key as a bearer token on every request:
        </p>
        <CodeBlock code="Authorization: Bearer lzr_live_your_key_here" />
        <p className="section-note">Base URL:</p>
        <CodeBlock code={API_BASE_URL} />
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
        <h3 className="api-mcp-heading">Using this from an AI agent: the MCP server</h3>
        <p className="section-note">
          Connect Claude Desktop, Claude Code, Cursor, or anything else that speaks MCP directly to your account.
          It wraps every endpoint above as a real tool the agent can call. Runs locally on your own machine using
          the key above; there's nothing to host.
        </p>
        <CodeBlock code={MCP_CONFIG_EXAMPLE} />

        <h3 className="api-mcp-heading">No install: the hosted MCP server</h3>
        <p className="section-note">
          Prefer not to install anything, or connecting from claude.ai rather than a desktop app? Same 6 tools,
          same account, but you sign in with this LazyRelay account the first time you connect instead of using
          an API key.
        </p>
        <CodeBlock code={HOSTED_MCP_URL} />
        <p className="section-note">
          In Claude: <strong>Settings → Connectors → Add connector → Remote</strong>, then paste the URL above.
          For MCP clients that use a config file instead:
        </p>
        <CodeBlock code={HOSTED_MCP_REMOTE_CONFIG_EXAMPLE} />
        <p className="section-note">
          To stop a connected app from accessing your account, remove it from wherever you connected it (for
          example, your AI tool's connector settings).
        </p>
        <div className="api-endpoint-list">
          {MCP_TOOLS.map((t) => (
            <div className="api-endpoint" key={t.name}>
              <div className="api-endpoint-header">
                <code>{t.name}</code>
              </div>
              <p>{t.summary}</p>
            </div>
          ))}
        </div>
      </section>
      )}
    </>
  );
}
