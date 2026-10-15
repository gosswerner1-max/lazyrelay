import { useId, useMemo, useState } from "react";
import { api, type WhatsAppImportResult } from "../../lib/api";
import {
  MAX_IMPORT_ROWS,
  describeReason,
  parseContactsCsv,
  previewImport,
  validateOptInDetails,
  type FormErrors,
  type ImportRow,
  type OptInDetails,
} from "../../lib/whatsappContacts";
import { WhatsAppConsentFields } from "./WhatsAppConsentFields";

// Import a CSV of people who said yes. The file is read in the browser, previewed (masked numbers, rows that will be skipped),
// checked with LazyRelay without saving anything (dry run: duplicates, numbers that opted out earlier), and only then imported.
// The file MUST have a phone column and an opted_in column. Nothing is sent to the contacts: Phase 1 only stores them.

const START_CONSENT: OptInDetails = { source: "customer_import", capturedAt: "", consentText: "", proofReference: "", attested: false };
const SHOWN_PROBLEMS = 20;

interface Props {
  socialAccountId: string;
  onImported: () => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");

export function WhatsAppContactImport({ socialAccountId, onImported }: Props) {
  const id = useId();
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [parseError, setParseError] = useState("");
  const [consent, setConsent] = useState<OptInDetails>(START_CONSENT);
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const [checked, setChecked] = useState<{ key: string; result: WhatsAppImportResult } | null>(null);
  const [done, setDone] = useState<WhatsAppImportResult | null>(null);

  const preview = useMemo(() => (rows ? previewImport(rows) : null), [rows]);
  // What was checked: the file and the consent details. If either changes, the check no longer counts.
  const currentKey = JSON.stringify([fileName, rows?.length ?? 0, consent]);
  const activeCheck = checked && checked.key === currentKey ? checked.result : null;

  async function onFile(file: File | undefined) {
    setChecked(null);
    setDone(null);
    setServerError("");
    setRows(null);
    setParseError("");
    if (!file) {
      setFileName("");
      return;
    }
    setFileName(file.name);
    const parsed = parseContactsCsv(await file.text());
    if (parsed.ok) setRows(parsed.rows);
    else setParseError(parsed.error);
  }

  function request(dryRun: boolean) {
    return api.importWhatsAppContacts({
      socialAccountId,
      source: consent.source,
      consentText: consent.consentText.trim(),
      proofReference: consent.proofReference.trim(),
      capturedAt: consent.capturedAt,
      dryRun,
      rows: (rows ?? []).map((r) => ({ phone: r.phone, name: r.name, opted_in: r.opted_in, opt_in_date: r.opt_in_date })),
    });
  }

  async function check() {
    setServerError("");
    setDone(null);
    const found = validateOptInDetails(consent);
    setErrors(found);
    if (Object.keys(found).length > 0 || !rows) return;
    setBusy(true);
    try {
      setChecked({ key: currentKey, result: await request(true) });
    } catch (err) {
      setServerError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!activeCheck) return;
    setBusy(true);
    setServerError("");
    try {
      const result = await request(false);
      setDone(result);
      setChecked(null);
      onImported();
    } catch (err) {
      setServerError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="byok-card wac-card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="wac-title">
        Import a CSV
      </h3>
      <p className="byok-card__hint">
        The first row must name the columns. Two are required: <code>phone</code> (with the country code, starting with +) and <code>opted_in</code> (yes or no for every person).
        Optional: <code>name</code> and <code>opt_in_date</code> (year-month-day). Rows that do not say yes are skipped. Up to {MAX_IMPORT_ROWS.toLocaleString("en-US")} contacts.
      </p>
      <div className="ph-no-capture ph-mask wac-import">
        <label className="byok-field wac-field">
          CSV file
          <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        {parseError && (
          <p className="byok-error" role="alert">
            {parseError}
          </p>
        )}
        {preview && (
          <div className="wac-preview" aria-live="polite">
            <p>
              <strong>{plural(preview.total, "contact found", "contacts found")}.</strong> {preview.ready} look ready, {preview.total - preview.ready} will be skipped.
            </p>
            {preview.sample.length > 0 && (
              <ul className="byok-conns">
                {preview.sample.map((s) => (
                  <li key={s.row}>
                    <span className="byok-conns__name">{s.name || "No name"}</span>
                    <span>{s.display}</span>
                  </li>
                ))}
              </ul>
            )}
            {preview.problems.length > 0 && (
              <>
                <p className="byok-card__hint">Rows that will be skipped:</p>
                <ul className="wac-problems">
                  {preview.problems.slice(0, SHOWN_PROBLEMS).map((p) => (
                    <li key={p.row}>
                      Row {p.row}: {describeReason(p.reason)}
                    </li>
                  ))}
                </ul>
                {preview.problems.length > SHOWN_PROBLEMS && <p className="byok-card__hint">and {preview.problems.length - SHOWN_PROBLEMS} more.</p>}
              </>
            )}
          </div>
        )}
      </div>
      {rows && (
        <>
          <WhatsAppConsentFields value={consent} onChange={(patch) => setConsent((c) => ({ ...c, ...patch }))} errors={errors} disabled={busy} />
          <div className="byok-actions">
            <button type="button" className="byok-secondary" disabled={busy} onClick={() => void check()}>
              {busy && !activeCheck ? "Checking..." : "Check the file"}
            </button>
            {activeCheck && activeCheck.accepted > 0 && (
              <button type="button" className="byok-primary" disabled={busy} onClick={() => void runImport()}>
                {busy ? "Importing..." : `Import ${plural(activeCheck.accepted, "contact", "contacts")}`}
              </button>
            )}
          </div>
        </>
      )}
      <div aria-live="polite">
        {serverError && <p className="byok-error">{serverError}</p>}
        {activeCheck && (
          <ul className="wac-result">
            <li>{activeCheck.accepted} will be added</li>
            {activeCheck.duplicates > 0 && <li>{activeCheck.duplicates} already in your list</li>}
            {activeCheck.suppressed > 0 && <li>{activeCheck.suppressed} opted out earlier and will be skipped</li>}
            {activeCheck.rejected.length > 0 && <li>{activeCheck.rejected.length} rejected by LazyRelay</li>}
          </ul>
        )}
        {done && (
          <p className="byok-status">
            Import finished. {plural(done.accepted, "contact", "contacts")} added
            {done.duplicates + done.suppressed + done.rejected.length > 0 ? `, ${done.duplicates + done.suppressed + done.rejected.length} skipped` : ""}.
          </p>
        )}
      </div>
    </section>
  );
}
