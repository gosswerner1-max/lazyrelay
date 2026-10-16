import { useId } from "react";
import { ATTESTATION_TEXT, MAX_CONSENT_TEXT, OPT_IN_SOURCES, todayUtc, type FormErrors, type OptInDetails } from "../../lib/whatsappContacts";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";

// The consent evidence a customer must give for every contact they add or import: where the consent came from (required), the
// date they gave it, the wording they saw, an optional proof reference, and the attestation tick. Shared by the single-contact
// form and the CSV import so both ask for exactly the same thing. The attestation wording is versioned
// (ATTESTATION_VERSION in lib/whatsappContacts.ts) and the backend stores the version with each consent record.

interface Props {
  value: OptInDetails;
  onChange: (patch: Partial<OptInDetails>) => void;
  errors: FormErrors;
  disabled?: boolean;
}

export function WhatsAppConsentFields({ value, onChange, errors, disabled }: Props) {
  const id = useId();
  const field = (name: keyof FormErrors) => ({
    "aria-invalid": errors[name] ? (true as const) : undefined,
    "aria-describedby": errors[name] ? `${id}-${name}-error` : undefined,
  });
  const error = (name: keyof FormErrors) =>
    errors[name] ? (
      <span id={`${id}-${name}-error`} className="byok-field__error" role="alert">
        {errors[name]}
      </span>
    ) : null;

  return (
    <div className="wac-consent">
      <div className="byok-fields">
        <label className="byok-field wac-field">
          Where did the consent come from?
          <select value={value.source} disabled={disabled} onChange={(e) => onChange({ source: e.target.value })} {...field("source")}>
            <option value="">Choose one</option>
            {OPT_IN_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {error("source")}
        </label>
        <label className="byok-field wac-field">
          Date they gave consent
          <input type="date" max={todayUtc()} value={value.capturedAt} disabled={disabled} onChange={(e) => onChange({ capturedAt: e.target.value })} {...field("capturedAt")} />
          {error("capturedAt")}
        </label>
        <label className="byok-field byok-field--wide wac-field">
          What did they agree to? (the words they saw)
          <textarea rows={3} maxLength={MAX_CONSENT_TEXT} value={value.consentText} disabled={disabled} onChange={(e) => onChange({ consentText: e.target.value })} {...field("consentText")} />
          {error("consentText")}
        </label>
        <label className="byok-field byok-field--wide wac-field">
          Proof reference (optional)
          <input type="text" maxLength={500} placeholder="For example a form name, order number or file name" value={value.proofReference} disabled={disabled} onChange={(e) => onChange({ proofReference: e.target.value })} {...field("proofReference")} />
          {error("proofReference")}
        </label>
      </div>
      <label className="byok-consent wac-attest">
        <input type="checkbox" checked={value.attested} disabled={disabled} onChange={(e) => onChange({ attested: e.target.checked })} {...field("attested")} />
        <span>{ATTESTATION_TEXT}</span>
      </label>
      {error("attested")}
    </div>
  );
}
