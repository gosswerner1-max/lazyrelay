import { useState } from "react";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

const STORAGE_KEY = "lazyrelay_cookie_consent";

interface ConsentChoices {
  analytics: boolean;
  personalization: boolean;
  targetedAdvertising: boolean;
}

function applyConsent(choices: ConsentChoices) {
  window.gtag?.("consent", "update", {
    analytics_storage: choices.analytics ? "granted" : "denied",
    personalization_storage: choices.personalization ? "granted" : "denied",
    ad_storage: choices.targetedAdvertising ? "granted" : "denied",
    ad_user_data: choices.targetedAdvertising ? "granted" : "denied",
    ad_personalization: choices.targetedAdvertising ? "granted" : "denied",
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
}

/** Reads a stored choice and re-applies it to Consent Mode — every fresh
 *  page load starts back at index.html's "denied" default, since consent
 *  state itself isn't persisted by gtag.js, only the choices object here
 *  is. Call this once at app startup (see main.tsx); it's a no-op if the
 *  visitor hasn't chosen yet. */
export function restoreStoredConsent(): void {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    applyConsent(JSON.parse(raw) as ConsentChoices);
  } catch {
    // Corrupted/old-shape value — treat as if nothing was ever stored
    // rather than throwing at startup.
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function CookieConsent() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(STORAGE_KEY) !== null);
  // Opt-IN, not opt-out -- these three used to default to true (pre-checked
  // before the visitor makes any choice at all), which is the exact pattern
  // GDPR's Planet49 ruling found non-compliant for non-essential cookies.
  // Harmless while no ad pixel reads ad_storage, but a real liability once
  // the paused Google Ads campaign goes live. Fixed 2026-08-25 before that
  // happened, not after. "Accept All" still turns everything on in one click.
  const [analytics, setAnalytics] = useState(false);
  const [personalization, setPersonalization] = useState(false);
  const [targetedAdvertising, setTargetedAdvertising] = useState(false);

  if (dismissed) return null;

  function commit(choices: ConsentChoices) {
    applyConsent(choices);
    setDismissed(true);
  }

  // Closing the banner without an explicit choice means "continue with
  // only essential cookies" per the copy below — same outcome as Reject
  // Non-Essential, just via the X instead of a labeled button.
  const rejectAll: ConsentChoices = { analytics: false, personalization: false, targetedAdvertising: false };

  return (
    <div className="cookie-consent" role="dialog" aria-label="Cookie preferences">
      <button className="cookie-consent-close" aria-label="Close" onClick={() => commit(rejectAll)}>
        &times;
      </button>
      <p>
        This website utilizes technologies such as cookies to enable essential site functionality, as well as for
        analytics, personalization, and targeted advertising. You may change your settings at any time or accept the
        default settings. You may close this banner to continue with only essential cookies.
      </p>
      <div className="cookie-consent-links">
        <a href="/privacy">Privacy Policy</a>
      </div>
      <label className="cookie-consent-toggle">
        <input
          type="checkbox"
          checked={targetedAdvertising}
          onChange={(e) => setTargetedAdvertising(e.target.checked)}
        />
        Targeted Advertising
      </label>
      <label className="cookie-consent-toggle">
        <input type="checkbox" checked={personalization} onChange={(e) => setPersonalization(e.target.checked)} />
        Personalization
      </label>
      <label className="cookie-consent-toggle">
        <input type="checkbox" checked={analytics} onChange={(e) => setAnalytics(e.target.checked)} />
        Analytics
      </label>
      <div className="cookie-consent-actions">
        <button
          className="cookie-consent-btn"
          onClick={() => commit({ analytics, personalization, targetedAdvertising })}
        >
          Save
        </button>
        <button
          className="cookie-consent-btn"
          onClick={() => commit({ analytics: true, personalization: true, targetedAdvertising: true })}
        >
          Accept All
        </button>
        <button className="cookie-consent-btn cookie-consent-btn-reject" onClick={() => commit(rejectAll)}>
          Reject Non-Essential
        </button>
      </div>
    </div>
  );
}
