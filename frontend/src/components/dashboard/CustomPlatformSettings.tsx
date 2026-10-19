import { useId, useState, type FormEvent } from "react";
import { api, type PlatformInfo, type SocialAccount, type WhatsAppCredentialFields } from "../../lib/api";
import { PlatformIcon } from "../PlatformIcon";
import { useByokDisclaimer } from "../ByokDisclaimerModal";
import { EMPTY_X_KEYS, X_BYOK_CONSENT_TEXT, X_BYOK_GUIDE_URL, X_KEY_MAX_LENGTH, xKeysComplete, type XKeyFields } from "../../lib/xByok";
import {
  EMPTY_WHATSAPP_FIELDS,
  META_ID_MAX_LENGTH,
  WHATSAPP_APP_SECRET_MAX_LENGTH,
  WHATSAPP_TOKEN_MAX_LENGTH,
  WHATSAPP_BYOK_CONSENT_TEXT,
  upgradeNote,
  whatsAppFieldErrors,
  whatsAppFieldsComplete,
  type WhatsAppFields,
} from "../../lib/whatsappByok";
import { ByokGuide } from "./ByokGuide";
import { WHATSAPP_GUIDE, X_GUIDE } from "../../lib/byokGuides";
import { WhatsAppInboundStatus } from "./WhatsAppInboundStatus";
import { WhatsAppThreadViewer } from "./WhatsAppThreadViewer";
import { WhatsAppWebhookDetails } from "./WhatsAppWebhookDetails";
import { useWhatsAppWebhookInfo, type WebhookInfoState } from "./useWhatsAppWebhookInfo";
import "../../styles/byok-panels.css";

// "Custom developer keys": where a customer links their OWN developer credentials for X and for WhatsApp, so the
// platform bills them directly. Layout only plus the form wiring: the backend decides who may connect (the platform
// list says visible, allowed and requiresPlan) and checks every value; this panel never decides.
//
// Secrets: every value lives only in this component's state. Never localStorage, never the URL, never a log line. The
// secret fields are cleared the moment they are submitted and after any error, and the panel never shows a stored
// secret back (the backend never returns one).

export interface CustomPlatformSettingsProps {
  /** The answer of GET /platforms. Only "x" and "whatsapp" matter here. A platform the backend does not list is not
   *  shown, so with the feature switches off this renders nothing at all. */
  platforms: PlatformInfo[];
  /** Called after a connection was saved, so the dashboard can reload its account list. */
  onConnected?: (platform: "x" | "whatsapp") => void;
  /** Shown as a "See plans" button on a card the plan does not include. The Settings view passes its own way of
   *  opening the Plan & billing sub-tab, so this panel adds no route. */
  onSeePlans?: () => void;
  /** The account's connected social accounts. The WhatsApp ones feed the message history viewer; leave it out and the
   *  viewer just says there is nothing connected yet. */
  accounts?: SocialAccount[];
}

const GENERIC_ERROR = "Something went wrong. Please try again.";
/** The note on a card the plan does not include, with the way to the plans. */
function LockedNote({ info, onSeePlans }: { info: PlatformInfo; onSeePlans?: () => void }) {
  return (
    <>
      <p className="byok-card__note">{upgradeNote(info)}</p>
      {onSeePlans && (
        <button type="button" className="byok-linkbtn" onClick={onSeePlans}>
          See plans
        </button>
      )}
    </>
  );
}

const APP_SECRET_HINT =
  "The App Secret is on your Meta app under App settings, Basic. Without it you can still link your number, but inbound messages stay off until it is saved. Saving again without one keeps the one already saved.";

const messageOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : GENERIC_ERROR);

interface FieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  /** Hidden like a password, with a show/hide button. */
  secret?: boolean;
  shown?: boolean;
  onToggleShown?: () => void;
  placeholder?: string;
  /** Longest value the field accepts, and the keyboard to show for it. */
  maxLength?: number;
  inputMode?: "numeric";
  /** Help text under the input, linked to it for screen readers. */
  hint?: string;
  /** Spans the whole row of a two-column card: for long values such as a token. */
  wide?: boolean;
}

function Field({ label, name, value, onChange, error, secret, shown, onToggleShown, placeholder, maxLength, inputMode, hint, wide }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={wide ? "byok-field byok-field--wide" : "byok-field"}>
      <label htmlFor={id}>{label}</label>
      <span className="byok-field__row">
        <input
          id={id}
          name={name}
          type={secret && !shown ? "password" : "text"}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          inputMode={inputMode}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
        {secret && onToggleShown && (
          <button type="button" className="byok-reveal" onClick={onToggleShown} aria-label={shown ? `Hide ${label}` : `Show ${label}`}>
            {shown ? "hide" : "show"}
          </button>
        )}
      </span>
      {hint && (
        <p id={hintId} className="byok-card__hint">
          {hint}
        </p>
      )}
      {error && (
        <span id={errorId} className="byok-field__error">
          {error}
        </span>
      )}
    </div>
  );
}

type CardProps = { info: PlatformInfo; onConnected?: CustomPlatformSettingsProps["onConnected"]; onSeePlans?: () => void };
type WhatsAppCardProps = CardProps & { webhookInfo: WebhookInfoState; onSaved: () => void };

function XCard({ info, onConnected, onSeePlans }: CardProps) {
  const [keys, setKeys] = useState<XKeyFields>(EMPTY_X_KEYS);
  const [showApiSecret, setShowApiSecret] = useState(false);
  const [showTokenSecret, setShowTokenSecret] = useState(false);
  const [showAccessToken, setShowAccessToken] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ handle: string; saved: boolean } | null>(null);
  const disclaimer = useByokDisclaimer();

  const set = (field: keyof XKeyFields) => (value: string) => {
    setKeys((k) => ({ ...k, [field]: value }));
    setResult(null);
  };
  const clearSecrets = () => {
    setKeys((k) => ({ ...k, apiSecret: "", accessToken: "", accessTokenSecret: "" }));
    setShowApiSecret(false);
    setShowAccessToken(false);
    setShowTokenSecret(false);
  };
  const filled = xKeysComplete(keys);

  if (info.allowed === false) {
    return (
      <section className="byok-card" aria-label="X developer keys">
        <h3 className="byok-card__title">
          <PlatformIcon platform="x" size={16} /> X <span className="byok-card__badge">Plan upgrade needed</span>
        </h3>
        <LockedNote info={info} onSeePlans={onSeePlans} />
      </section>
    );
  }

  async function handleCheck() {
    setError(null);
    setResult(null);
    setBusy("check");
    try {
      const r = await api.checkXKeys({
        apiKey: keys.apiKey.trim(),
        apiSecret: keys.apiSecret.trim(),
        accessToken: keys.accessToken.trim(),
        accessTokenSecret: keys.accessTokenSecret.trim(),
      });
      setResult({ handle: r.handle, saved: false });
    } catch (err) {
      clearSecrets();
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accepted || !filled || busy) return;
    disclaimer.ask(() => void doSave());
  }

  async function doSave() {
    setError(null);
    setBusy("save");
    const toSend = {
      apiKey: keys.apiKey.trim(),
      apiSecret: keys.apiSecret.trim(),
      accessToken: keys.accessToken.trim(),
      accessTokenSecret: keys.accessTokenSecret.trim(),
    };
    clearSecrets(); // gone from the form the moment they are on their way
    try {
      const r = await api.connectXKeys(toSend);
      setKeys(EMPTY_X_KEYS);
      setAccepted(false);
      setResult({ handle: r.handle, saved: true });
      onConnected?.("x");
    } catch (err) {
      clearSecrets();
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="byok-card" aria-label="X developer keys">
      <h3 className="byok-card__title">
        <PlatformIcon platform="x" size={16} /> X
      </h3>
      <p className="byok-card__note">
        <strong>X bills your own developer account for every post.</strong> LazyRelay never pays for it.
      </p>
      <p className="byok-card__hint">
        <a href={X_BYOK_GUIDE_URL} target="_blank" rel="noopener noreferrer">
          Read the 5-minute setup guide
        </a>{" "}
        (opens in a new tab)
      </p>
      <ByokGuide guide={X_GUIDE} />
      <form onSubmit={handleSubmit} autoComplete="off">
        <div className="byok-fields">
          <Field label="API Key (Consumer Key)" name="x-api-key" value={keys.apiKey} onChange={set("apiKey")} maxLength={X_KEY_MAX_LENGTH} />
          <Field label="API Secret (Consumer Secret)" name="x-api-secret" value={keys.apiSecret} onChange={set("apiSecret")} secret shown={showApiSecret} onToggleShown={() => setShowApiSecret((v) => !v)} maxLength={X_KEY_MAX_LENGTH} />
          <Field
            label="Access Token"
            name="x-access-token"
            value={keys.accessToken}
            onChange={set("accessToken")}
            maxLength={X_KEY_MAX_LENGTH}
            secret
            shown={showAccessToken}
            onToggleShown={() => setShowAccessToken((v) => !v)}
          />
          <Field
            label="Access Token Secret"
            name="x-access-token-secret"
            value={keys.accessTokenSecret}
            onChange={set("accessTokenSecret")}
            maxLength={X_KEY_MAX_LENGTH}
            secret
            shown={showTokenSecret}
            onToggleShown={() => setShowTokenSecret((v) => !v)}
          />
        </div>
        <p className="byok-card__hint">Make sure the Access Token says "Read and Write". The four keys are stored encrypted, and you can remove them any time.</p>
        <label className="byok-consent">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>{X_BYOK_CONSENT_TEXT}</span>
        </label>
        <div className="byok-actions">
          <button type="button" className="byok-secondary" disabled={!filled || busy !== null} onClick={() => disclaimer.ask(() => void handleCheck())}>
            {busy === "check" ? "Checking..." : "Check my keys"}
          </button>
          <button type="submit" className="byok-primary" disabled={!accepted || !filled || busy !== null}>
            {busy === "save" ? "Connecting..." : "Save and connect"}
          </button>
        </div>
        {result && !result.saved && (
          <p role="status" className="byok-status">
            Keys accepted. They belong to @{result.handle}. Tick the box and choose Save and connect.
          </p>
        )}
        {result?.saved && (
          <p role="status" className="byok-status">
            Connected as @{result.handle}.
          </p>
        )}
        {error && (
          <p role="alert" className="byok-error">
            {error}
          </p>
        )}
      </form>
      {disclaimer.modal}
    </section>
  );
}

function WhatsAppCard({ info, onConnected, onSeePlans, webhookInfo, onSaved }: WhatsAppCardProps) {
  const [fields, setFields] = useState<WhatsAppFields>(EMPTY_WHATSAPP_FIELDS);
  const [showToken, setShowToken] = useState(false);
  const [showAppSecret, setShowAppSecret] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string | null; saved: boolean } | null>(null);
  const disclaimer = useByokDisclaimer();

  const set = (field: keyof WhatsAppFields) => (value: string) => {
    setFields((f) => ({ ...f, [field]: value }));
    setResult(null);
  };
  // Both secrets (the token and the optional App Secret) leave the form together, on submit and on every error.
  const clearSecret = () => {
    setFields((f) => ({ ...f, systemUserToken: "", appSecret: "" }));
    setShowToken(false);
    setShowAppSecret(false);
  };
  const problems = whatsAppFieldErrors(fields);
  const complete = whatsAppFieldsComplete(fields);

  if (info.allowed === false) {
    return (
      <section className="byok-card" aria-label="WhatsApp developer keys">
        <h3 className="byok-card__title">
          <PlatformIcon platform="whatsapp" size={16} /> WhatsApp <span className="byok-card__badge">Plan upgrade needed</span>
        </h3>
        <LockedNote info={info} onSeePlans={onSeePlans} />
      </section>
    );
  }

  const trimmed = (): WhatsAppCredentialFields => {
    const appSecret = (fields.appSecret ?? "").trim();
    return {
      wabaId: fields.wabaId.trim(),
      phoneNumberId: fields.phoneNumberId.trim(),
      systemUserToken: fields.systemUserToken.trim(),
      ...(appSecret ? { appSecret } : {}), // only sent when typed
    };
  };

  async function handleCheck() {
    setError(null);
    setResult(null);
    setBusy("check");
    try {
      const r = await api.checkWhatsAppCredentials(trimmed());
      setResult({ name: r.displayName, saved: false });
    } catch (err) {
      clearSecret();
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accepted || !complete || busy) return;
    disclaimer.ask(() => void doSave());
  }

  async function doSave() {
    setError(null);
    setBusy("save");
    const toSend = trimmed();
    clearSecret(); // gone from the form the moment it is on its way
    try {
      const r = await api.connectWhatsAppCredentials(toSend);
      setFields(EMPTY_WHATSAPP_FIELDS);
      setAccepted(false);
      setResult({ name: r.displayName, saved: true });
      onSaved(); // the inbound status reloads
      onConnected?.("whatsapp");
    } catch (err) {
      clearSecret();
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="byok-card" aria-label="WhatsApp developer keys">
      <h3 className="byok-card__title">
        <PlatformIcon platform="whatsapp" size={16} /> WhatsApp
      </h3>
      <p className="byok-card__note">
        <strong>Meta bills your own WhatsApp Business Account directly.</strong> LazyRelay never pays for it.
      </p>
      <p className="byok-card__hint">Connect your own WhatsApp number here, then send and read messages in the WhatsApp tab.</p>
      <ByokGuide guide={WHATSAPP_GUIDE} />
      <form onSubmit={handleSubmit} autoComplete="off">
        <div className="byok-fields">
          <Field label="WABA ID" placeholder="WhatsApp Business Account ID" name="whatsapp-waba-id" value={fields.wabaId} onChange={set("wabaId")} error={problems.wabaId} inputMode="numeric" maxLength={META_ID_MAX_LENGTH} />
          <Field label="Phone number ID" name="whatsapp-phone-number-id" value={fields.phoneNumberId} onChange={set("phoneNumberId")} error={problems.phoneNumberId} inputMode="numeric" maxLength={META_ID_MAX_LENGTH} />
          <Field
            label="System user token"
            name="whatsapp-system-user-token"
            value={fields.systemUserToken}
            onChange={set("systemUserToken")}
            error={problems.systemUserToken}
            maxLength={WHATSAPP_TOKEN_MAX_LENGTH}
            wide
            secret
            shown={showToken}
            onToggleShown={() => setShowToken((v) => !v)}
          />
          <Field
            label="App Secret (optional)"
            name="whatsapp-app-secret"
            value={fields.appSecret ?? ""}
            onChange={set("appSecret")}
            error={problems.appSecret}
            maxLength={WHATSAPP_APP_SECRET_MAX_LENGTH}
            hint={APP_SECRET_HINT}
            wide
            secret
            shown={showAppSecret}
            onToggleShown={() => setShowAppSecret((v) => !v)}
          />
        </div>
        <p className="byok-card__hint">The token and App Secret are stored encrypted and are never shown again. You can remove them any time.</p>
        <WhatsAppInboundStatus state={webhookInfo} onSecretRemoved={onSaved} />
        <WhatsAppWebhookDetails state={webhookInfo} />
        <label className="byok-consent">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>{WHATSAPP_BYOK_CONSENT_TEXT}</span>
        </label>
        <p className="byok-card__hint">Saving connects your number. You send and read messages in the WhatsApp tab.</p>
        <div className="byok-actions">
          <button type="button" className="byok-secondary" disabled={!complete || busy !== null} onClick={() => disclaimer.ask(() => void handleCheck())}>
            {busy === "check" ? "Checking..." : "Check my credentials"}
          </button>
          <button type="submit" className="byok-primary" disabled={!accepted || !complete || busy !== null}>
            {busy === "save" ? "Connecting..." : "Save and connect"}
          </button>
        </div>
        {result && !result.saved && (
          <p role="status" className="byok-status">
            Credentials accepted{result.name ? ` for ${result.name}` : ""}.
          </p>
        )}
        {result?.saved && (
          <p role="status" className="byok-status">
            Connected{result.name ? ` as ${result.name}` : ""}.
          </p>
        )}
        {error && (
          <p role="alert" className="byok-error">
            {error}
          </p>
        )}
      </form>
      {disclaimer.modal}
    </section>
  );
}

export function CustomPlatformSettings({ platforms, onConnected, onSeePlans, accounts }: CustomPlatformSettingsProps) {
  const x = platforms.find((p) => p.platform === "x");
  const whatsapp = platforms.find((p) => p.platform === "whatsapp");
  const whatsappOpen = Boolean(whatsapp) && whatsapp?.allowed !== false;
  // Bumped after a WhatsApp connection was saved, so the inbound status reloads. Locked plan: nothing is requested.
  const [reloadKey, setReloadKey] = useState(0);
  const webhookInfo = useWhatsAppWebhookInfo(whatsappOpen, reloadKey);
  const inboundReady = webhookInfo.status === "ready" ? Object.fromEntries(webhookInfo.info.connections.map((c) => [c.socialAccountId, c.inboundReady])) : undefined;
  if (!x && !whatsapp) return null;

  return (
    <section className="byok-panels" aria-labelledby="byok-panels-heading">
      <div className="byok-panels__head">
        <h2 id="byok-panels-heading">Custom developer keys</h2>
        <p>
          Link your own developer accounts. The platform bills you directly and LazyRelay never pays for it. Your keys are stored encrypted, and you
          can remove them any time.
        </p>
      </div>
      <div className={`byok-panels__grid${x && whatsapp ? " byok-panels__grid--two" : ""}`}>
        {x && <XCard info={x} onConnected={onConnected} onSeePlans={onSeePlans} />}
        {whatsapp && <WhatsAppCard info={whatsapp} onConnected={onConnected} onSeePlans={onSeePlans} webhookInfo={webhookInfo} onSaved={() => setReloadKey((k) => k + 1)} />}
      </div>
      {whatsappOpen && (
        <WhatsAppThreadViewer accounts={accounts ?? []} triageEnabled={webhookInfo.status === "ready" ? webhookInfo.info.triageEnabled : null} inboundReady={inboundReady} />
      )}
    </section>
  );
}
