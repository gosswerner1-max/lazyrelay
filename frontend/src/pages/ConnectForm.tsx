import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";

type ManualPlatform = "bluesky" | "telegram" | "discord";

const PLATFORM_LABELS: Record<ManualPlatform, string> = {
  bluesky: "Bluesky",
  telegram: "Telegram",
  discord: "Discord",
};

interface ConnectFormProps {
  platform: ManualPlatform;
  state: string;
}

// Bluesky/Telegram/Discord don't have real OAuth (see platforms/*.ts on the
// backend) — each needs a credential collected directly from the customer,
// JSON-encoded as the `code` the generic /social-accounts/callback route
// already expects. One page, three field sets, same submit shape.
export function ConnectForm({ platform, state }: ConnectFormProps) {
  const [handle, setHandle] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [channelUsername, setChannelUsername] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const code =
        platform === "bluesky"
          ? JSON.stringify({ identifier: handle, password: appPassword })
          : platform === "telegram"
            ? JSON.stringify({ channelUsername })
            : JSON.stringify({ webhookUrl });
      await api.completeManualConnect(code, state);
      setDone(true);
      setTimeout(() => {
        window.location.href = "/";
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="auth-page auth-page--compact">
        <div className="auth-card">
          <BrandMark size={40} />
          <h1>Connected!</h1>
          <p>Taking you back to your dashboard...</p>
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
          <PlatformIcon platform={platform} size={16} /> Connect {PLATFORM_LABELS[platform]}
        </p>
        <form onSubmit={handleSubmit}>
          {platform === "bluesky" && (
            <>
              <label>
                Handle
                <input
                  type="text"
                  placeholder="you.bsky.social"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  required
                />
              </label>
              <label>
                App password
                <input
                  type="password"
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  value={appPassword}
                  onChange={(e) => setAppPassword(e.target.value)}
                  required
                />
              </label>
              <p className="field-hint">
                Create one at bsky.app under Settings &rarr; Privacy and security &rarr; App passwords. Don't use your main account password.
              </p>
            </>
          )}
          {platform === "telegram" && (
            <>
              <label>
                Channel username
                <input
                  type="text"
                  placeholder="@yourchannel"
                  value={channelUsername}
                  onChange={(e) => setChannelUsername(e.target.value)}
                  required
                />
              </label>
              <p className="field-hint">
                The channel must be public, and @lazyrelay_bot must already be added as an admin with post permission.
              </p>
            </>
          )}
          {platform === "discord" && (
            <>
              <label>
                Webhook URL
                <input
                  type="text"
                  placeholder="https://discord.com/api/webhooks/..."
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  required
                />
              </label>
              <p className="field-hint">
                Create one in your server under Channel Settings &rarr; Integrations &rarr; Webhooks &rarr; New Webhook, then copy the webhook URL.
              </p>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? "Connecting..." : "Connect"}
          </button>
        </form>
      </div>
      <a className="link" href="/">
        &larr; Back to dashboard
      </a>
    </div>
  );
}
