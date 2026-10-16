import { useId, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { validateAddContact, type FormErrors, type OptInDetails } from "../../lib/whatsappContacts";
import { WhatsAppConsentFields } from "./WhatsAppConsentFields";

// Add one WhatsApp contact together with the proof that they said yes. Nothing is sent to the contact: Phase 1 only stores
// the contact and the consent record. The number goes to the server and is never shown again, only a mask.

const EMPTY_CONSENT: OptInDetails = { source: "", capturedAt: "", consentText: "", proofReference: "", attested: false };

interface Props {
  socialAccountId: string;
  onAdded: () => void;
}

export function WhatsAppOptInForm({ socialAccountId, onAdded }: Props) {
  const id = useId();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState<OptInDetails>(EMPTY_CONSENT);
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [serverError, setServerError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage("");
    setServerError("");
    const found = validateAddContact({ ...consent, phone, name });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const result = await api.addWhatsAppContact({
        socialAccountId,
        phone,
        name: name.trim(),
        optIn: { source: consent.source, capturedAt: consent.capturedAt, consentText: consent.consentText.trim(), proofReference: consent.proofReference.trim(), attested: true },
      });
      setMessage(result.status === "created" ? "Contact added." : "That number is already in your list.");
      setPhone("");
      setName("");
      onAdded();
    } catch (err) {
      setServerError(err instanceof Error && err.message ? err.message : "Could not add the contact. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="byok-card wac-card" onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="wac-title">
        Add a contact
      </h3>
      <p className="byok-card__hint">Only add people who said yes to WhatsApp marketing messages. The number is stored encrypted and is never shown again, only a masked version.</p>
      <div className="byok-fields ph-no-capture ph-mask">
        <label className="byok-field wac-field">
          Phone number
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="+27 82 123 4567"
            value={phone}
            disabled={busy}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={errors.phone ? true : undefined}
            aria-describedby={errors.phone ? `${id}-phone-error` : undefined}
          />
          {errors.phone && (
            <span id={`${id}-phone-error`} className="byok-field__error" role="alert">
              {errors.phone}
            </span>
          )}
        </label>
        <label className="byok-field wac-field">
          Name (optional)
          <input type="text" autoComplete="off" maxLength={80} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} aria-invalid={errors.name ? true : undefined} />
          {errors.name && (
            <span className="byok-field__error" role="alert">
              {errors.name}
            </span>
          )}
        </label>
      </div>
      <WhatsAppConsentFields value={consent} onChange={(patch) => setConsent((c) => ({ ...c, ...patch }))} errors={errors} disabled={busy} />
      <div className="byok-actions">
        <button type="submit" className="byok-primary" disabled={busy}>
          {busy ? "Adding..." : "Add contact"}
        </button>
      </div>
      <div aria-live="polite">
        {Object.keys(errors).length > 0 && <p className="byok-error">Some details are missing or not right. Check the highlighted fields.</p>}
        {serverError && <p className="byok-error">{serverError}</p>}
        {message && <p className="byok-status">{message}</p>}
      </div>
    </form>
  );
}
