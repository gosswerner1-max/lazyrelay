import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, type WhatsAppChatMessage, type WhatsAppConversation, type WhatsAppTemplate } from "../../lib/api";
import { safeDisplay, safeName } from "../../lib/whatsappThreads";
import { COPY, messageStatusLabel, windowLabel } from "../../lib/whatsappSend";
import { usePolling } from "../../lib/usePolling";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";
import "../../styles/whatsapp-chat.css";

// One conversation. Free-form replies only while Meta's 24 hour customer-service window is open (the window state is shown at the top);
// outside it only an approved template can be sent, and only to a saved contact who opted in. Approval requests send three reply buttons
// (Approve, Request changes, Question) inside the window, or an approved template outside it. An approval is a convenience record, not
// legal consent. The server applies every gate again: this screen only chooses what to show.

const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");
const code = (err: unknown) => (err instanceof Error ? (err as Error & { code?: string }).code : undefined);
const when = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

const FAILURE_TEXT: Record<string, string> = {
  transient_error: "WhatsApp could not take it just now. You can send it again.",
  unconfirmed_no_response: "WhatsApp did not answer, so it may or may not have been sent.",
  recipient_opted_out: "This person opted out.",
};

interface Props {
  conversationId: string;
  /** Called after something changed, so the inbox list reloads. */
  onChanged?: () => void;
}

export function WhatsAppThread({ conversationId, onChanged }: Props) {
  const id = useId();
  const [conversation, setConversation] = useState<WhatsAppConversation | null>(null);
  const [messages, setMessages] = useState<WhatsAppChatMessage[]>([]);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [trackTitle, setTrackTitle] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [askTitle, setAskTitle] = useState("");
  const [askBody, setAskBody] = useState("");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const bottom = useRef<HTMLLIElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getWhatsAppThread(conversationId);
      setConversation(r.conversation);
      setMessages(r.messages);
      setState("ready");
      return r.conversation;
    } catch (err) {
      setError(errText(err));
      setState("error");
      return null;
    }
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setError("");
    load().then((c) => {
      if (cancelled || !c || c.unreadCount === 0) return;
      api
        .markWhatsAppConversationRead(conversationId)
        .then(() => onChanged?.())
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    api
      .listWhatsAppTemplates(conversation?.socialAccountId ?? "")
      .then((r) => {
        if (!cancelled) setTemplates(r.templates.filter((t) => t.usable));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversation?.socialAccountId]);

  usePolling(() => void load(), 15_000, state === "ready");

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);

  const chosen = useMemo(() => templates.find((t) => t.id === templateId) ?? null, [templates, templateId]);

  function pickTemplate(nextId: string) {
    setTemplateId(nextId);
    const t = templates.find((x) => x.id === nextId);
    setParams(Array.from({ length: t?.variableCount ?? 0 }, () => ""));
    setProblems({});
  }

  async function afterSend(refreshed = true) {
    setError("");
    if (refreshed) await load();
    onChanged?.();
  }

  async function reportFailure(err: unknown) {
    setError(errText(err));
    // The window can close while someone is typing: reload so the screen offers the template instead.
    if (code(err) === "window_closed" || code(err) === "window_closed_template_required") await load();
  }

  async function sendReply() {
    const body = text.trim();
    if (body === "") {
      setProblems({ text: "Type a message first." });
      return;
    }
    setProblems({});
    setBusy(true);
    try {
      await api.replyWhatsApp(conversationId, body);
      setText("");
      await afterSend();
    } catch (err) {
      await reportFailure(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendApproval() {
    const found: Record<string, string> = {};
    if (askTitle.trim() === "") found.askTitle = "Say what is being approved.";
    if (askBody.trim() === "") found.askBody = "Write the message your client will read.";
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      await api.sendWhatsAppApprovalRequest(conversationId, { title: askTitle.trim(), body: askBody.trim() });
      setAskTitle("");
      setAskBody("");
      setAskOpen(false);
      await afterSend();
    } catch (err) {
      await reportFailure(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendTemplate() {
    const found: Record<string, string> = {};
    if (!chosen) found.template = "Pick an approved template.";
    else if (params.length !== chosen.variableCount || params.some((p) => p.trim() === "")) found.params = "Fill in every value.";
    setProblems(found);
    if (Object.keys(found).length > 0 || !chosen) return;
    setBusy(true);
    try {
      const cleaned = params.map((p) => p.trim());
      if (trackTitle.trim() !== "") await api.sendWhatsAppApprovalRequest(conversationId, { title: trackTitle.trim(), body: chosen.bodyText, templateId: chosen.id, params: cleaned });
      else await api.sendWhatsAppTemplate(conversationId, chosen.id, cleaned);
      setTemplateId("");
      setParams([]);
      setTrackTitle("");
      await afterSend();
    } catch (err) {
      await reportFailure(err);
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return <p className="byok-card__hint">Loading conversation...</p>;
  if (!conversation) return <p className="byok-error">{error || "That conversation could not be loaded."}</p>;
  const w = conversation.window;
  const label = safeName(conversation.displayName) ?? safeDisplay(conversation.contactDisplay);
  const alertFor = (key: string) =>
    problems[key] ? (
      <span className="byok-field__error" role="alert">
        {problems[key]}
      </span>
    ) : null;

  return (
    <div className="wac-thread ph-no-capture ph-mask" aria-labelledby={`${id}-title`}>
      <div className="wac-thread-head">
        <h3 id={`${id}-title`} className="wac-title">
          {label}
        </h3>
        <span className={`byok-chip ${w.open ? "byok-chip--ok" : "byok-chip--off"}`}>{windowLabel(w)}</span>
      </div>
      {!conversation.isContact && <p className="wac-small">{COPY.unknownPerson}</p>}
      <ul className="wac-messages" aria-label="Messages">
        {messages.map((m) => (
          <li key={m.id} className={`wac-msg${m.direction === "outbound" ? " wac-msg--out" : ""}${m.status === "failed" ? " wac-msg--failed" : ""}`}>
            <span>{m.text}</span>
            {m.approval && (
              <div className="wac-approval">
                <strong>Approval request: {m.approval.title}</strong>
                <span>Buttons: {m.approval.options.map((o) => o.title).join(", ")}</span>
                <span className={`byok-chip ${m.approval.status === "approved" ? "byok-chip--ok" : "byok-chip--off"}`}>{approvalLabel(m.approval.status)}</span>
                {m.approval.responseTitle && (
                  <span>
                    They tapped: {m.approval.responseTitle} {when(m.approval.respondedAt)}
                  </span>
                )}
              </div>
            )}
            <span className="wac-msg-meta">
              {when(m.occurredAt)}
              {m.direction === "outbound" && messageStatusLabel(m.status) !== "" && <> <span>{messageStatusLabel(m.status)}</span></>}
              {m.status === "failed" && m.failureReason && FAILURE_TEXT[m.failureReason] && <> {FAILURE_TEXT[m.failureReason]}</>}
            </span>
          </li>
        ))}
        <li ref={bottom} aria-hidden="true" />
      </ul>

      <div className="wac-composer">
        {w.open ? (
          <>
            <label className="byok-field wac-field">
              Message
              <textarea rows={3} maxLength={4096} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} aria-invalid={problems.text ? true : undefined} />
              {alertFor("text")}
            </label>
            <div className="byok-actions">
              <button type="button" className="byok-primary" disabled={busy} onClick={() => void sendReply()}>
                {busy ? "Sending..." : "Send"}
              </button>
              <button type="button" className="byok-secondary" disabled={busy} onClick={() => setAskOpen((v) => !v)}>
                Ask for approval
              </button>
            </div>
            {askOpen && (
              <div className="wac-composer">
                <p className="wac-small">{COPY.approvalNote}</p>
                <p className="wac-small">Your client sees three buttons: Approve, Request changes, Question.</p>
                <label className="byok-field wac-field">
                  What is being approved?
                  <input type="text" maxLength={60} value={askTitle} onChange={(e) => setAskTitle(e.target.value)} aria-invalid={problems.askTitle ? true : undefined} />
                  {alertFor("askTitle")}
                </label>
                <label className="byok-field wac-field">
                  Message to your client
                  <textarea rows={3} maxLength={1024} value={askBody} onChange={(e) => setAskBody(e.target.value)} aria-invalid={problems.askBody ? true : undefined} />
                  {alertFor("askBody")}
                </label>
                <div className="byok-actions">
                  <button type="button" className="byok-primary" disabled={busy} onClick={() => void sendApproval()}>
                    Send request
                  </button>
                </div>
              </div>
            )}
          </>
        ) : conversation.isContact ? (
          <>
            <p className="wac-small">{COPY.windowNote}</p>
            <label className="byok-field wac-field">
              Template
              <select value={templateId} disabled={busy} onChange={(e) => pickTemplate(e.target.value)} aria-invalid={problems.template ? true : undefined}>
                <option value="">Choose a template</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.language}, {t.category})
                  </option>
                ))}
              </select>
              {alertFor("template")}
            </label>
            {chosen && <p className="wac-template-body">{chosen.bodyText}</p>}
            {params.map((value, i) => (
              <label key={i} className="byok-field wac-field">
                {`Value ${i + 1}`}
                <input type="text" maxLength={1024} value={value} onChange={(e) => setParams((cur) => cur.map((v, j) => (j === i ? e.target.value : v)))} />
              </label>
            ))}
            {alertFor("params")}
            {chosen && (
              <label className="byok-field wac-field">
                Track this as an approval request (optional title)
                <input type="text" maxLength={60} value={trackTitle} onChange={(e) => setTrackTitle(e.target.value)} />
              </label>
            )}
            <div className="byok-actions">
              <button type="button" className="byok-primary" disabled={busy} onClick={() => void sendTemplate()}>
                {busy ? "Sending..." : "Send template"}
              </button>
            </div>
          </>
        ) : (
          <p className="wac-small">{COPY.windowNote}</p>
        )}
        {error && <p className="byok-error">{error}</p>}
      </div>
    </div>
  );
}

function approvalLabel(s: string): string {
  const map: Record<string, string> = { pending: "Waiting for an answer", approved: "Approved", changes_requested: "Changes requested", question: "Has a question", other_reply: "Replied another way" };
  return map[s] ?? "Unknown";
}
