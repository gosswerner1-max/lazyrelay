import { useEffect, useId, useMemo, useState } from "react";
import { api, type WhatsAppBroadcastPreview, type WhatsAppTemplate } from "../../lib/api";
import { COPY, costLine, localInputToIso, validateBroadcast, type BroadcastErrors } from "../../lib/whatsappSend";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";
import "../../styles/whatsapp-chat.css";

// Schedule a broadcast: pick an approved template, fill in its values, choose when, preview, schedule. Nothing is sent from this
// screen: the server sends at the scheduled time, only to opted-in contacts, only with the customer's own Meta login. The server stays
// the authority on every rule; this form only checks the obvious first.

const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");

interface Props {
  socialAccountId: string;
  /** Called after a broadcast was scheduled, so the list reloads. */
  onCreated: () => void;
  /** Change this to reload the templates (after a sync). */
  refreshKey?: number;
}

export function WhatsAppBroadcastComposer({ socialAccountId, onCreated, refreshKey = 0 }: Props) {
  const id = useId();
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [when, setWhen] = useState("");
  const [errors, setErrors] = useState<BroadcastErrors>({});
  const [preview, setPreview] = useState<WhatsAppBroadcastPreview | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "schedule">("");
  const [serverError, setServerError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .listWhatsAppTemplates(socialAccountId)
      .then((r) => {
        if (cancelled) return;
        setTemplates(r.templates.filter((t) => t.usable));
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setServerError(errText(err));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [socialAccountId, refreshKey]);

  const chosen = useMemo(() => templates.find((t) => t.id === templateId) ?? null, [templates, templateId]);
  const variableCount = chosen?.variableCount ?? 0;

  function pick(nextId: string) {
    setTemplateId(nextId);
    setPreview(null);
    const t = templates.find((x) => x.id === nextId);
    setParams(Array.from({ length: t?.variableCount ?? 0 }, () => ""));
  }

  function check(): boolean {
    const found = validateBroadcast({ connectionId: socialAccountId, templateId, name, params, variableCount, scheduledLocal: when });
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  async function run(kind: "preview" | "schedule") {
    setServerError("");
    setMessage("");
    if (!check()) return;
    setBusy(kind);
    try {
      const scheduledFor = localInputToIso(when)!;
      const r = await api.createWhatsAppBroadcast({ socialAccountId, templateId, name: name.trim(), params: params.map((p) => p.trim()), scheduledFor, dryRun: kind === "preview" ? true : undefined });
      setPreview(r.preview);
      if (kind === "schedule") {
        setMessage(`Your broadcast is scheduled for ${new Date(scheduledFor).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`);
        setName("");
        setParams(Array.from({ length: variableCount }, () => ""));
        setWhen("");
        onCreated();
      }
    } catch (err) {
      setServerError(errText(err));
    } finally {
      setBusy("");
    }
  }

  const noTemplates = loaded && templates.length === 0;
  const aria = (key: keyof BroadcastErrors) => ({ "aria-invalid": errors[key] ? (true as const) : undefined });
  const err = (key: keyof BroadcastErrors) =>
    errors[key] ? (
      <span className="byok-field__error" role="alert">
        {errors[key]}
      </span>
    ) : null;

  return (
    <section className="byok-card wac-card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="wac-title">
        New broadcast
      </h3>
      <p className="byok-card__hint">{COPY.optOutNote} {COPY.handedOffNote}</p>
      {noTemplates && <p className="byok-card__hint">{COPY.noTemplates}</p>}
      <div className="wac-form-grid">
        <label className="byok-field wac-field">
          Template
          <select value={templateId} disabled={noTemplates} onChange={(e) => pick(e.target.value)} {...aria("template")}>
            <option value="">Choose a template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.language}, {t.category})
              </option>
            ))}
          </select>
          {err("template")}
        </label>
        <label className="byok-field wac-field">
          Name of this broadcast
          <input type="text" maxLength={80} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} {...aria("name")} />
          {err("name")}
        </label>
      </div>
      {chosen && <p className="wac-template-body">{chosen.bodyText}</p>}
      {variableCount > 0 && (
        <div className="wac-form-grid">
          {params.map((value, i) => (
            <label key={i} className="byok-field wac-field">
              {`Value ${i + 1}`}
              <input type="text" maxLength={1024} autoComplete="off" value={value} onChange={(e) => setParams((cur) => cur.map((v, j) => (j === i ? e.target.value : v)))} {...aria("params")} />
            </label>
          ))}
        </div>
      )}
      {err("params")}
      <label className="byok-field wac-field">
        Send at
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} {...aria("schedule")} />
        {err("schedule")}
      </label>
      <div className="byok-actions">
        <button type="button" className="byok-secondary" disabled={busy !== "" || noTemplates} onClick={() => void run("preview")}>
          {busy === "preview" ? "Checking..." : "Preview"}
        </button>
        <button type="button" className="byok-primary" disabled={busy !== "" || noTemplates} onClick={() => void run("schedule")}>
          {busy === "schedule" ? "Scheduling..." : "Schedule broadcast"}
        </button>
      </div>
      <div aria-live="polite" className="wac-result">
        {preview && (
          <div>
            <p>{preview.audience === 1 ? "1 person will get this." : `${preview.audience} people will get this.`}</p>
            {preview.excludedUs > 0 && (
              <p className="wac-small">
                {preview.excludedUs} {preview.excludedUs === 1 ? "contact with a US (+1) number is" : "contacts with US (+1) numbers are"} left out. {COPY.usNote}
              </p>
            )}
            <p className="wac-small">{costLine(preview.estimatedCost)}</p>
          </div>
        )}
        {serverError && <p className="byok-error">{serverError}</p>}
        {message && <p className="byok-status">{message}</p>}
      </div>
    </section>
  );
}
