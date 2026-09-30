import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";

type ManualPlatform = "bluesky" | "telegram" | "discord" | "wordpress" | "devto" | "hashnode" | "lemmy";

const PLATFORM_LABELS: Record<ManualPlatform, string> = {
  bluesky: "Bluesky",
  telegram: "Telegram",
  discord: "Discord",
  wordpress: "WordPress",
  devto: "dev.to",
  hashnode: "Hashnode",
  lemmy: "Lemmy",
};

// Client IDs are public by design (they're embedded in every OAuth URL),
// unlike the client secret/bot token, which stay server-side only.
// Permissions integer 68608 = View Channels + Send Messages + Read
// Message History, matching DISCORD_BOT_PERMISSIONS in discord.ts and
// exactly what the bot's Discord Developer Portal page was configured
// with 2026-09-08. scope=bot is a plain add-to-server flow -- no redirect
// or code exchange needed, so this can be a static link.
const DISCORD_BOT_INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=1546826540627529729&permissions=68608&scope=bot";

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
  const [botToken, setBotToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState(""); // application password, API key, access token or Lemmy password
  const [extra, setExtra] = useState(""); // Hashnode publication address, Lemmy default community
  const [instance, setInstance] = useState("");
  const [totp, setTotp] = useState("");
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
            ? JSON.stringify({ botToken, channelUsername })
            : platform === "discord"
              ? JSON.stringify({ webhookUrl })
              : platform === "wordpress"
                ? JSON.stringify({ siteUrl, username, applicationPassword: secret })
                : platform === "devto"
                  ? JSON.stringify({ apiKey: secret })
                  : platform === "hashnode"
                    ? JSON.stringify({ token: secret, ...(extra.trim() ? { publicationHost: extra.trim() } : {}) })
                    : JSON.stringify({ instance, username, password: secret, ...(totp.trim() ? { totpToken: totp.trim() } : {}), ...(extra.trim() ? { community: extra.trim() } : {}) });
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
                Bot token
                <input
                  type="password"
                  placeholder="123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  required
                />
              </label>
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
                Create your own bot by messaging @BotFather on Telegram (send /newbot and follow the prompts) — it gives you a token to paste above. The channel must be public, and your bot must be added as an admin there with "Post Messages" permission.
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
                {" "}
                <a href={DISCORD_BOT_INVITE_URL} target="_blank" rel="noreferrer">
                  Also invite the LazyRelay bot to this server
                </a>{" "}
                if you want to reply to comments from LazyRelay too — posting works either way.
              </p>
            </>
          )}
          {platform === "wordpress" && (
            <>
              <label>
                Your site address
                <input type="text" placeholder="https://yoursite.com" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} required />
              </label>
              <label>
                Username
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
              </label>
              <label>
                Application password
                <input type="password" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" value={secret} onChange={(e) => setSecret(e.target.value)} required />
              </label>
              <p className="field-hint">
                Works with your own WordPress site (version 5.6 or newer, address starting with https). In WordPress go to Users &rarr; Profile, scroll to Application Passwords, type LazyRelay as the name and click Add. Copy the password it shows once. Do not use your normal login password.
              </p>
            </>
          )}
          {platform === "devto" && (
            <>
              <label>
                dev.to API key
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required />
              </label>
              <p className="field-hint">
                On dev.to open Settings &rarr; Extensions, find DEV Community API Keys, type LazyRelay as the description and click Generate API Key. Copy the key and paste it above.
              </p>
            </>
          )}
          {platform === "hashnode" && (
            <>
              <label>
                Personal access token
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required />
              </label>
              <label>
                Blog address (only if you have more than one)
                <input type="text" placeholder="yourname.hashnode.dev" value={extra} onChange={(e) => setExtra(e.target.value)} />
              </label>
              <p className="field-hint">
                Hashnode now charges for API access, so your blog needs Hashnode's Pro plan for LazyRelay to post to it. On Hashnode open Account settings &rarr; Developer, click Generate New Token and paste it above.
              </p>
            </>
          )}
          {platform === "lemmy" && (
            <>
              <label>
                Your Lemmy server
                <input type="text" placeholder="lemmy.world" value={instance} onChange={(e) => setInstance(e.target.value)} required />
              </label>
              <label>
                Username
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
              </label>
              <label>
                Password
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required />
              </label>
              <label>
                Two-factor code (only if you use one)
                <input type="text" inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value)} />
              </label>
              <label>
                Community to post in (optional, for example programming@programming.dev)
                <input type="text" value={extra} onChange={(e) => setExtra(e.target.value)} />
              </label>
              <p className="field-hint">
                LazyRelay stores a login token, not your password. In Lemmy open Settings &rarr; Profile and tick Bot account, because Lemmy expects automated posts to come from a bot-marked account.
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
