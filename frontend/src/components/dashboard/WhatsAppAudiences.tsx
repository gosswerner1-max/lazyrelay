import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { api, type WhatsAppAudience, type WhatsAppContact, type WhatsAppTemplate, type WhatsAppUpdateResult } from "../../lib/api";
import { safeDisplay, safeName } from "../../lib/whatsappThreads";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";
import "../../styles/whatsapp-chat.css";

// Saved audiences (groups of saved contacts who opted in) and short update lines sent to one. Each person is sent the update their own
// way: typed freely if their 24 hour window is open, the approved template you pick if it is closed, otherwise skipped. Sent one at a
// time with the customer's own Meta login, through the same gates as a broadcast, to at most 25 people at once. People are shown by a
// name or a masked number, never the number.

const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");

const SKIP_TEXT: Record<string, string> = {
  window_closed: "window closed and no template chosen",
  opted_out: "opted out",
  no_opt_in: "no opt-in on record",
  us_marketing_blocked: "marketing templates are not delivered to US numbers",
  not_found: "contact not found",
};

function resultText(r: WhatsAppUpdateResult["results"][number]): string {
  if (r.status === "sent") return r.how === "template" ? "Sent as a template" : "Sent as a message";
  if (r.status === "not_attempted") return "Not attempted, sending stopped";
  if (r.status === "skipped") return `Skipped: ${SKIP_TEXT[r.code ?? ""] ?? "not sent"}`;
  return "Not sent: WhatsApp did not accept it";
}

export function WhatsAppAudiences({ socialAccountId }: { socialAccountId: string }) {
  const id = useId();
  const [audiences, setAudiences] = useState<WhatsAppAudience[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [open, setOpen] = useState<{ id: string; mode: "add" | "update" } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contacts, setContacts] = useState<WhatsAppContact[]>([]);
  const [ticked, setTicked] = useState<string[]>([]);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [text, setText] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [result, setResult] = useState<WhatsAppUpdateResult | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.listWhatsAppAudiences(socialAccountId);
      setAudiences(r.audiences);
      setError("");
      setState("ready");
    } catch (err) {
      setError(errText(err));
      setState("error");
    }
  }, [socialAccountId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    api
      .listWhatsAppTemplates(socialAccountId)
      .then((r) => {
        if (!cancelled) setTemplates(r.templates.filter((t) => t.usable));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [socialAccountId]);

  const chosen = useMemo(() => templates.find((t) => t.id === templateId) ?? null, [templates, templateId]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setNameError("");
    if (name.trim() === "") {
      setNameError("Give the audience a name.");
      return;
    }
    setBusy(true);
    try {
      await api.createWhatsAppAudience(socialAccountId, name.trim());
      setName("");
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function openPanel(audienceId: string, mode: "add" | "update") {
    setOpen({ id: audienceId, mode });
    setProblems({});
    setResult(null);
    setMessage("");
    setTicked([]);
    if (mode === "add") {
      try {
        const r = await api.listWhatsAppContacts({ socialAccountId, status: "opted_in", limit: 100 });
        setContacts(r.contacts);
      } catch (err) {
        setError(errText(err));
      }
    }
  }

  async function addSelected(audienceId: string) {
    if (ticked.length === 0) return;
    setBusy(true);
    try {
      const r = await api.addWhatsAppAudienceMembers(audienceId, ticked);
      setMessage(`Added ${r.added}${r.skipped > 0 ? `, skipped ${r.skipped}` : ""}.`);
      setTicked([]);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(audienceId: string) {
    setBusy(true);
    try {
      await api.deleteWhatsAppAudience(audienceId);
      setConfirmId(null);
      setOpen(null);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendUpdate(audienceId: string) {
    const found: Record<string, string> = {};
    if (text.trim() === "") found.text = "Write the update first.";
    if (chosen && (params.length !== chosen.variableCount || params.some((p) => p.trim() === ""))) found.params = "Fill in every value for the template.";
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError("");
    try {
      const body = chosen ? { text: text.trim(), templateId: chosen.id, params: params.map((p) => p.trim()) } : { text: text.trim() };
      setResult(await api.sendWhatsAppAudienceUpdate(audienceId, body));
      setText("");
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="byok-card wac-card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="wac-title">
        Audiences and updates
      </h3>
      <p className="byok-card__hint">Group saved contacts who opted in, then send them a short update. Up to 25 people at once. For more, use a broadcast.</p>
      <form className="wac-search" onSubmit={create} noValidate>
        <label className="byok-field wac-field">
          New audience name
          <input type="text" maxLength={80} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameError ? true : undefined} />
          {nameError && (
            <span className="byok-field__error" role="alert">
              {nameError}
            </span>
          )}
        </label>
        <div className="byok-actions">
          <button type="submit" className="byok-secondary" disabled={busy}>
            Create audience
          </button>
        </div>
      </form>
      {error && <p className="byok-error">{error}</p>}
      {state === "loading" && <p className="byok-card__hint">Loading audiences...</p>}
      {state === "ready" && audiences.length === 0 && <p className="byok-card__hint">No audiences yet.</p>}
      {audiences.length > 0 && (
        <ul className="byok-conns wac-list ph-no-capture ph-mask">
          {audiences.map((a) => (
            <li key={a.id}>
              <div className="wac-broadcast">
                <div className="wac-broadcast-head">
                  <span className="wac-big">{a.name}</span>
                  <span className="wac-small">{a.memberCount === 1 ? "1 person" : `${a.memberCount} people`}</span>
                </div>
                <div className="byok-actions">
                  <button type="button" className="byok-secondary" aria-label={`Add people to ${a.name}`} onClick={() => void openPanel(a.id, "add")}>
                    Add people
                  </button>
                  <button type="button" className="byok-secondary" aria-label={`Send an update to ${a.name}`} onClick={() => void openPanel(a.id, "update")}>
                    Send an update
                  </button>
                  {confirmId === a.id ? (
                    <div role="group" aria-label="Confirm delete" className="wac-confirm">
                      <span>Delete this audience? The contacts stay saved.</span>
                      <button type="button" className="byok-primary" disabled={busy} onClick={() => void remove(a.id)}>
                        Yes, delete it
                      </button>
                      <button type="button" className="byok-secondary" onClick={() => setConfirmId(null)}>
                        Keep it
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="byok-secondary" aria-label={`Delete ${a.name}`} onClick={() => setConfirmId(a.id)}>
                      Delete
                    </button>
                  )}
                </div>
                {open?.id === a.id && open.mode === "add" && (
                  <div className="wac-composer">
                    {contacts.length === 0 && <p className="wac-small">No saved contacts who opted in yet.</p>}
                    {contacts.map((c) => {
                      const label = safeName(c.displayName) ?? safeDisplay(c.contactDisplay);
                      return (
                        <label key={c.id} className="byok-consent">
                          <input type="checkbox" checked={ticked.includes(c.id)} onChange={(e) => setTicked((cur) => (e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id)))} />
                          <span>
                            {label} <span className="wac-small">{safeName(c.displayName) ? safeDisplay(c.contactDisplay) : ""}</span>
                          </span>
                        </label>
                      );
                    })}
                    <div className="byok-actions">
                      <button type="button" className="byok-primary" disabled={busy || ticked.length === 0} onClick={() => void addSelected(a.id)}>
                        Add selected
                      </button>
                    </div>
                    {message && <p className="byok-status">{message}</p>}
                  </div>
                )}
                {open?.id === a.id && open.mode === "update" && (
                  <div className="wac-composer">
                    <p className="wac-small">Typed freely to people whose 24 hour window is open. Everyone else gets the template you pick, or is skipped if you pick none. Anyone who opted out is skipped.</p>
                    <label className="byok-field wac-field">
                      Update
                      <textarea rows={3} maxLength={4096} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={problems.text ? true : undefined} />
                      {problems.text && (
                        <span className="byok-field__error" role="alert">
                          {problems.text}
                        </span>
                      )}
                    </label>
                    <label className="byok-field wac-field">
                      Template for people outside the 24 hour window (optional)
                      <select
                        value={templateId}
                        onChange={(e) => {
                          setTemplateId(e.target.value);
                          const t = templates.find((x) => x.id === e.target.value);
                          setParams(Array.from({ length: t?.variableCount ?? 0 }, () => ""));
                        }}
                      >
                        <option value="">No template</option>
                        {templates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.language}, {t.category})
                          </option>
                        ))}
                      </select>
                    </label>
                    {chosen && <p className="wac-template-body">{chosen.bodyText}</p>}
                    {params.map((value, i) => (
                      <label key={i} className="byok-field wac-field">
                        {`Value ${i + 1}`}
                        <input type="text" maxLength={1024} value={value} onChange={(e) => setParams((cur) => cur.map((v, j) => (j === i ? e.target.value : v)))} />
                      </label>
                    ))}
                    {problems.params && (
                      <span className="byok-field__error" role="alert">
                        {problems.params}
                      </span>
                    )}
                    <div className="byok-actions">
                      <button type="button" className="byok-primary" disabled={busy} onClick={() => void sendUpdate(a.id)}>
                        {busy ? "Sending..." : "Send update"}
                      </button>
                    </div>
                    {result && (
                      <div aria-live="polite">
                        <p>
                          Sent to {result.summary.sent} of {result.summary.total}.
                        </p>
                        <ul className="wac-problems">
                          {result.results.map((r, i) => (
                            <li key={i}>
                              {r.contactDisplay ? `${safeDisplay(r.contactDisplay)}: ` : ""}
                              {resultText(r)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
