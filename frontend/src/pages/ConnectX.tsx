import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";
import { EMPTY_X_KEYS, X_BYOK_CONSENT_TEXT, X_BYOK_GUIDE_URL, xKeysComplete, type XKeyFields } from "../lib/xByok";

// Connect X with the customer's OWN developer keys (OAuth 1.0a). The four values live only in this component's state:
// never in localStorage, never in the URL. The two secrets are cleared the moment they are submitted and after any error.
export function ConnectX() {
  const [keys, setKeys] = useState<XKeyFields>(EMPTY_X_KEYS);
  const [showApiSecret, setShowApiSecret] = useState(false);
  const [showTokenSecret, setShowTokenSecret] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okHandle, setOkHandle] = useState<{ handle: string; saved: boolean } | null>(null);

  const set = (field: keyof XKeyFields) => (e: { target: { value: string } }) => {
    setKeys((k) => ({ ...k, [field]: e.target.value }));
    setOkHandle(null);
  };
  const clearSecrets = () => {
    setKeys((k) => ({ ...k, apiSecret: "", accessTokenSecret: "" }));
    setShowApiSecret(false);
    setShowTokenSecret(false);
  };
  const filled = xKeysComplete(keys);

  async function handleCheck() {
    setError(null);
    setOkHandle(null);
    setBusy("check");
    try {
      const r = await api.checkXKeys(keys);
      setOkHandle({ handle: r.handle, saved: false });
    } catch (err) {
      clearSecrets();
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accepted || !filled || busy) return;
    setError(null);
    setBusy("save");
    const toSend = keys;
    clearSecrets(); // gone from the form the moment they are on their way
    try {
      const r = await api.connectXKeys(toSend);
      setKeys(EMPTY_X_KEYS);
      setOkHandle({ handle: r.handle, saved: true });
      setTimeout(() => {
        window.location.href = "/";
      }, 1500);
    } catch (err) {
      clearSecrets();
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  if (okHandle?.saved) {
    return (
      <div className="auth-page auth-page--compact">
        <div className="auth-card">
          <BrandMark size={40} />
          <h1>Connected!</h1>
          <p>Connected as @{okHandle.handle}. Taking you back to your dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page auth-page--compact">
      <div className="auth-card">
        <div className="wordmark">
          <BrandMark size={36} />
          <span style={{ fontSize: 22 }}>LazyRelay</span>
        </div>
        <p className="subtitle">
          <PlatformIcon platform="x" size={16} /> Connect X with your own developer app
        </p>
        <p className="field-hint">Step 1 of 1: paste your four X keys</p>
        <p className="field-hint">
          <strong>X bills YOUR developer account for every post.</strong> LazyRelay never pays for it. A plain post costs about $0.015 and a post
          with a link about $0.20 (X's prices, they may change).
        </p>
        <p className="field-hint">
          <a href={X_BYOK_GUIDE_URL} target="_blank" rel="noopener noreferrer">
            Read the 5-minute setup guide
          </a>{" "}
          (opens in a new tab)
        </p>
        <form onSubmit={handleSubmit} autoComplete="off">
          <label>
            API Key
            <input type="text" name="x-api-key" autoComplete="off" autoCapitalize="none" spellCheck={false} value={keys.apiKey} onChange={set("apiKey")} required />
          </label>
          <label>
            API Secret
            <span style={{ display: "flex", gap: 8 }}>
              <input
                type={showApiSecret ? "text" : "password"}
                name="x-api-secret"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={keys.apiSecret}
                onChange={set("apiSecret")}
                required
              />
              <button type="button" className="btn-outline" onClick={() => setShowApiSecret((v) => !v)} aria-label={showApiSecret ? "Hide API Secret" : "Show API Secret"}>
                {showApiSecret ? "hide" : "show"}
              </button>
            </span>
          </label>
          <label>
            Access Token
            <input type="text" name="x-access-token" autoComplete="off" autoCapitalize="none" spellCheck={false} value={keys.accessToken} onChange={set("accessToken")} required />
          </label>
          <label>
            Access Token Secret
            <span style={{ display: "flex", gap: 8 }}>
              <input
                type={showTokenSecret ? "text" : "password"}
                name="x-access-token-secret"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={keys.accessTokenSecret}
                onChange={set("accessTokenSecret")}
                required
              />
              <button type="button" className="btn-outline" onClick={() => setShowTokenSecret((v) => !v)} aria-label={showTokenSecret ? "Hide Access Token Secret" : "Show Access Token Secret"}>
                {showTokenSecret ? "hide" : "show"}
              </button>
            </span>
          </label>
          <p className="field-hint">Make sure the Access Token says "Read and Write". We store the four keys encrypted. Remove them any time.</p>

          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} style={{ marginTop: 4 }} />
            <span>{X_BYOK_CONSENT_TEXT}</span>
          </label>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn-outline" disabled={!filled || busy !== null} onClick={handleCheck}>
              {busy === "check" ? "Checking..." : "Check my keys"}
            </button>
            <button type="submit" disabled={!accepted || !filled || busy !== null}>
              {busy === "save" ? "Connecting..." : "Save and connect"}
            </button>
          </div>
          {okHandle && !okHandle.saved && (
            <p role="status" className="field-hint">
              OK. Keys accepted. Connected as @{okHandle.handle}. Tick the box above and choose Save and connect.
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
        <p className="field-hint">
          <a href="/">Back to dashboard</a>
        </p>
      </div>
    </div>
  );
}
