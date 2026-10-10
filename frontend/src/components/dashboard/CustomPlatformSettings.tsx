import { useId, useState, type FormEvent } from "react";
import { api, type PlatformInfo } from "../../lib/api";
import { PlatformIcon } from "../PlatformIcon";
import { EMPTY_X_KEYS, X_BYOK_CONSENT_TEXT, X_BYOK_GUIDE_URL, xKeysComplete, type XKeyFields } from "../../lib/xByok";
import {
  EMPTY_WHATSAPP_FIELDS,
  WHATSAPP_BYOK_CONSENT_TEXT,
  upgradeNote,
  whatsAppFieldErrors,
  whatsAppFieldsComplete,
  type WhatsAppFields,
} from "../../lib/whatsappByok";
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
}

const GENERIC_ERROR = "Something went wrong. Please try again.";
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
  /** Spans the whole row of a two-column card: for long values such as a token. */
  wide?: boolean;
}

function Field({ label, name, value, onChange, error, secret, shown, onToggleShown, placeholder, wide }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
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
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {secret && onToggleShown && (
          <button type="button" className="byok-reveal" onClick={onToggleShown} aria-label={shown ? `Hide ${label}` : `Show ${label}`}>
            {shown ? "hide" : "show"}
          </button>
        )}
      </span>
      {error && (
        <span id={errorId} className="byok-field__error">
          {error}
        </span>
      )}
    </div>
  );
}

function XCard({ info, onConnected }: { info: PlatformInfo; onConnected?: CustomPlatformSettingsProps["onConnected"] }) {
  const [keys, setKeys] = useState<XKeyFields>(EMPTY_X_KEYS);
  const [showApiSecret, setShowApiSecret] = useState(false);
  const [showTokenSecret, setShowTokenSecret] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ handle: string; saved: boolean } | null>(null);

  const set = (field: keyof XKeyFields) => (value: string) => {
    setKeys((k) => ({ ...k, [field]: value }));
    setResult(null);
  };
  const clearSecrets = () => {
    setKeys((k) => ({ ...k, apiSecret: "", accessTokenSecret: "" }));
    setShowApiSecret(false);
    setShowTokenSecret(false);
  };
  const filled = xKeysComplete(keys);

  if (info.allowed === false) {
    return (
      <section className="byok-card" aria-label="X developer keys">
        <h3 className="byok-card__title">
          <PlatformIcon platform="x" size={16} /> X <span className="byok-card__badge">Plan upgrade needed</span>
        </h3>
        <p className="byok-card__note">{upgradeNote(info)}</p>
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accepted || !filled || busy) return;
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
      <form onSubmit={handleSubmit} autoComplete="off">
        <div className="byok-fields">
          <Field label="API Key (Consumer Key)" name="x-api-key" value={keys.apiKey} onChange={set("apiKey")} />
          <Field label="API Secret (Consumer Secret)" name="x-api-secret" value={keys.apiSecret} onChange={set("apiSecret")} secret shown={showApiSecret} onToggleShown={() => setShowApiSecret((v) => !v)} />
          <Field label="Access Token" name="x-access-token" value={keys.accessToken} onChange={set("accessToken")} />
          <Field
            label="Access Token Secret"
            name="x-access-token-secret"
            value={keys.accessTokenSecret}
            onChange={set("accessTokenSecret")}
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
          <button type="button" className="byok-secondary" disabled={!filled || busy !== null} onClick={handleCheck}>
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
    </section>
  );
}

function WhatsAppCard({ info, onConnected }: { info: PlatformInfo; onConnected?: CustomPlatformSettingsProps["onConnected"] }) {
  const [fields, setFields] = useState<WhatsAppFields>(EMPTY_WHATSAPP_FIELDS);
  const [showToken, setShowToken] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string | null; saved: boolean } | null>(null);

  const set = (field: keyof WhatsAppFields) => (value: string) => {
    setFields((f) => ({ ...f, [field]: value }));
    setResult(null);
  };
  const clearSecret = () => {
    setFields((f) => ({ ...f, systemUserToken: "" }));
    setShowToken(false);
  };
  const problems = whatsAppFieldErrors(fields);
  const complete = whatsAppFieldsComplete(fields);

  if (info.allowed === false) {
    return (
      <section className="byok-card" aria-label="WhatsApp developer keys">
        <h3 className="byok-card__title">
          <PlatformIcon platform="whatsapp" size={16} /> WhatsApp <span className="byok-card__badge">Plan upgrade needed</span>
        </h3>
        <p className="byok-card__note">{upgradeNote(info)}</p>
      </section>
    );
  }

  const trimmed = (): WhatsAppFields => ({
    wabaId: fields.wabaId.trim(),
    phoneNumberId: fields.phoneNumberId.trim(),
    systemUserToken: fields.systemUserToken.trim(),
  });

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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accepted || !complete || busy) return;
    setError(null);
    setBusy("save");
    const toSend = trimmed();
    clearSecret(); // gone from the form the moment it is on its way
    try {
      const r = await api.connectWhatsAppCredentials(toSend);
      setFields(EMPTY_WHATSAPP_FIELDS);
      setAccepted(false);
      setResult({ name: r.displayName, saved: true });
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
      <p className="byok-card__hint">You can link your number now. Publishing to WhatsApp is not available yet, so nothing will be sent through it.</p>
      <form onSubmit={handleSubmit} autoComplete="off">
        <div className="byok-fields">
          <Field label="WhatsApp Business Account ID (WABA ID)" name="whatsapp-waba-id" value={fields.wabaId} onChange={set("wabaId")} error={problems.wabaId} />
          <Field label="Phone number ID" name="whatsapp-phone-number-id" value={fields.phoneNumberId} onChange={set("phoneNumberId")} error={problems.phoneNumberId} />
          <Field
            label="System user token"
            name="whatsapp-system-user-token"
            value={fields.systemUserToken}
            onChange={set("systemUserToken")}
            error={problems.systemUserToken}
            wide
            secret
            shown={showToken}
            onToggleShown={() => setShowToken((v) => !v)}
          />
        </div>
        <p className="byok-card__hint">The token is stored encrypted and is never shown again. You can remove it any time.</p>
        <label className="byok-consent">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>{WHATSAPP_BYOK_CONSENT_TEXT}</span>
        </label>
        <div className="byok-actions">
          <button type="button" className="byok-secondary" disabled={!complete || busy !== null} onClick={handleCheck}>
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
    </section>
  );
}

export function CustomPlatformSettings({ platforms, onConnected }: CustomPlatformSettingsProps) {
  const x = platforms.find((p) => p.platform === "x");
  const whatsapp = platforms.find((p) => p.platform === "whatsapp");
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
        {x && <XCard info={x} onConnected={onConnected} />}
        {whatsapp && <WhatsAppCard info={whatsapp} onConnected={onConnected} />}
      </div>
    </section>
  );
}
