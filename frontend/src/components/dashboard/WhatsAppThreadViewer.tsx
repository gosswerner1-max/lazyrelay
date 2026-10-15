import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type SocialAccount, type WhatsAppMessage } from "../../lib/api";
import { groupThreads, mergeMessages, threadLabel, triageBadges, type WhatsAppThread } from "../../lib/whatsappThreads";

// Read-only history of the WhatsApp messages LazyRelay received for one connected number (GET /whatsapp/messages).
// There is no sending here: sending is not built. The backend never has a phone number, so a conversation is shown by the
// profile name plus a masked number, never anything more.
//
// Two screens in one panel:
//   - Conversations: the newest 100 messages of the number, grouped into conversations, newest conversation first.
//     "Load older messages" pages further back.
//   - One conversation: fetched on its own (so it is complete, not just the part inside the first 100), shown OLDEST TO
//     NEWEST; "Load older" adds earlier messages above the ones already shown.

const LIST_PAGE = 100;
const THREAD_PAGE = 50;

interface Pager {
  status: "loading" | "ready" | "error";
  messages: WhatsAppMessage[];
  nextBefore: string | null;
  error: string;
  loadingMore: boolean;
}
const LOADING: Pager = { status: "loading", messages: [], nextBefore: null, error: "", loadingMore: false };
const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Could not load the messages. Please try again.");

/** Never throws: a failure comes back as an error pager. */
async function fetchPage(socialAccountId: string, contactKey: string | undefined, before: string | undefined, limit: number): Promise<Pager> {
  try {
    const page = await api.getWhatsAppMessages({ socialAccountId, contactKey, before, limit });
    return { status: "ready", messages: page.messages, nextBefore: page.nextBefore, error: "", loadingMore: false };
  } catch (err) {
    return { status: "error", messages: [], nextBefore: null, error: errText(err), loadingMore: false };
  }
}

export interface WhatsAppThreadViewerProps {
  accounts: SocialAccount[];
  /** From the server: whether AI sorting is on. null while unknown, which leaves the AI sentence out. */
  triageEnabled: boolean | null;
  /** Per connection, from the server: false means inbound is off until an App Secret is saved. */
  inboundReady?: Record<string, boolean>;
}

function Badges({ m }: { m: Pick<WhatsAppMessage, "needsAttention" | "triageCategory"> }) {
  const badges = triageBadges(m);
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((b) => (
        <span key={b.text} className={`byok-chip byok-chip--${b.tone}`}>
          {b.text}
        </span>
      ))}
    </>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export function WhatsAppThreadViewer({ accounts, triageEnabled, inboundReady }: WhatsAppThreadViewerProps) {
  const headingId = useId();
  const connections = useMemo(() => accounts.filter((a) => a.platform === "whatsapp"), [accounts]);
  const [picked, setPicked] = useState("");
  const connId = connections.some((c) => c.id === picked) ? picked : (connections[0]?.id ?? "");
  // Results are stored with the key they were fetched for, and only shown while that key is still the one on screen. So
  // a slow answer for a number or conversation the customer already left is never shown, and nothing needs resetting.
  const [listState, setListState] = useState<{ key: string; pager: Pager } | null>(null);
  const [open, setOpen] = useState<{ conn: string; contactKey: string } | null>(null);
  const [threadState, setThreadState] = useState<{ key: string; pager: Pager } | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const threadHeadRef = useRef<HTMLHeadingElement>(null);

  const list = listState && listState.key === connId ? listState.pager : LOADING;
  const openKey = open && open.conn === connId ? open.contactKey : null;
  const threadKey = openKey ? `${connId}|${openKey}` : "";
  const thread = threadState && threadState.key === threadKey ? threadState.pager : LOADING;

  // Conversations of the chosen number.
  useEffect(() => {
    if (!connId) return;
    let cancelled = false;
    void fetchPage(connId, undefined, undefined, LIST_PAGE).then((pager) => {
      if (!cancelled) setListState({ key: connId, pager });
    });
    return () => {
      cancelled = true;
    };
  }, [connId]);

  const threads = useMemo(() => groupThreads(list.messages), [list.messages]);

  function openThread(t: WhatsAppThread) {
    const key = `${connId}|${t.contactKey}`;
    setOpen({ conn: connId, contactKey: t.contactKey });
    requestAnimationFrame(() => threadHeadRef.current?.focus());
    void fetchPage(connId, t.contactKey, undefined, THREAD_PAGE).then((pager) => setThreadState({ key, pager }));
  }
  function closeThread() {
    setOpen(null);
    requestAnimationFrame(() => listRef.current?.focus());
  }
  /** Adds an older page to whichever screen is showing `key`, or records the error; ignored if that screen has moved on. */
  function mergeOlder(set: typeof setListState, key: string, p: Pager) {
    set((s) => {
      if (!s || s.key !== key) return s;
      if (p.status !== "ready") return { key, pager: { ...s.pager, loadingMore: false, error: p.error } };
      return { key, pager: { ...s.pager, messages: mergeMessages(s.pager.messages, p.messages), nextBefore: p.nextBefore, loadingMore: false, error: "" } };
    });
  }
  async function olderInList() {
    if (!list.nextBefore || list.loadingMore) return;
    const key = connId;
    setListState((s) => (s && s.key === key ? { key, pager: { ...s.pager, loadingMore: true } } : s));
    mergeOlder(setListState, key, await fetchPage(connId, undefined, list.nextBefore, LIST_PAGE));
  }
  async function olderInThread() {
    if (!thread.nextBefore || thread.loadingMore || !openKey) return;
    const key = threadKey;
    setThreadState((s) => (s && s.key === key ? { key, pager: { ...s.pager, loadingMore: true } } : s));
    mergeOlder(setThreadState, key, await fetchPage(connId, openKey, thread.nextBefore, THREAD_PAGE));
  }

  function onListKey(e: KeyboardEvent<HTMLUListElement>) {
    if (threads.length === 0) return;
    const move = (i: number) => {
      e.preventDefault();
      setActive(Math.max(0, Math.min(threads.length - 1, i)));
    };
    if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(threads.length - 1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openThread(threads[Math.min(active, threads.length - 1)]);
    }
  }

  const notes = (
    <p className="byok-card__hint">
      Messages are deleted after 30 days.{triageEnabled === false ? " AI sorting is off." : ""}
    </p>
  );

  if (connections.length === 0) {
    return (
      <section className="byok-card byok-viewer" aria-labelledby={headingId}>
        <h3 id={headingId} className="byok-card__title">
          WhatsApp messages
        </h3>
        <p className="byok-card__hint">Connect a WhatsApp number above and the messages it receives will show here.</p>
        {notes}
      </section>
    );
  }

  const openThreadData = openKey ? threads.find((t) => t.contactKey === openKey) : undefined;
  const threadMessages = [...thread.messages].sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
  const heading = openKey ? (openThreadData?.label ?? (threadMessages.length ? threadLabel(threadMessages[threadMessages.length - 1]) : "Conversation")) : "";

  return (
    <section className="byok-card byok-viewer" aria-labelledby={headingId}>
      <h3 id={headingId} className="byok-card__title">
        WhatsApp messages
      </h3>
      <div className="byok-field">
        <label htmlFor={`${headingId}-conn`}>WhatsApp number</label>
        <select id={`${headingId}-conn`} className="byok-select" value={connId} onChange={(e) => setPicked(e.target.value)}>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.display_name ?? "WhatsApp"}
            </option>
          ))}
        </select>
      </div>
      {notes}
      {inboundReady && inboundReady[connId] === false && (
        <p className="byok-card__hint">
          <span className="byok-chip byok-chip--off">Inbound off: App Secret not saved</span> New messages will not arrive for this number until one is saved.
        </p>
      )}

      {!openKey && (
        <div className="byok-viewer__list">
          {list.status === "loading" && (
            <p role="status" className="byok-card__hint">
              Loading messages...
            </p>
          )}
          {list.status === "error" && (
            <p role="alert" className="byok-error">
              {list.error}
            </p>
          )}
          {list.status === "ready" && threads.length === 0 && <p className="byok-card__hint">No messages yet. New WhatsApp messages sent to this number will show here.</p>}
          {threads.length > 0 && (
            <ul
              ref={listRef}
              className="byok-threads"
              role="listbox"
              tabIndex={0}
              aria-label="Conversations, newest first. Use the arrow keys and press Enter to open one."
              aria-activedescendant={`${headingId}-t${Math.min(active, threads.length - 1)}`}
              onKeyDown={onListKey}
            >
              {threads.map((t, i) => (
                <li
                  key={t.contactKey}
                  id={`${headingId}-t${i}`}
                  role="option"
                  aria-selected={i === Math.min(active, threads.length - 1)}
                  className="byok-thread"
                  onClick={() => openThread(t)}
                >
                  <span className="byok-thread__top">
                    <span className="byok-thread__name">{t.label}</span>
                    <time dateTime={t.latestAt}>{when(t.latestAt)}</time>
                  </span>
                  <span className="byok-thread__preview">{t.latestText}</span>
                  <span className="byok-thread__meta">
                    {t.count} {t.count === 1 ? "message" : "messages"}
                    {t.needsAttention && <span className="byok-chip byok-chip--attention">Needs attention</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {list.status === "ready" && list.error && (
            <p role="alert" className="byok-error">
              {list.error}
            </p>
          )}
          {list.nextBefore && (
            <button type="button" className="byok-linkbtn" disabled={list.loadingMore} onClick={() => void olderInList()}>
              {list.loadingMore ? "Loading..." : "Load older messages"}
            </button>
          )}
        </div>
      )}

      {openKey && (
        <div className="byok-viewer__thread">
          <button type="button" className="byok-linkbtn" onClick={closeThread}>
            Back to conversations
          </button>
          <h4 ref={threadHeadRef} tabIndex={-1} className="byok-thread__title">
            {heading}
          </h4>
          <p className="byok-card__hint">Oldest messages first.</p>
          {thread.status === "loading" && (
            <p role="status" className="byok-card__hint">
              Loading messages...
            </p>
          )}
          {thread.status === "error" && (
            <p role="alert" className="byok-error">
              {thread.error}
            </p>
          )}
          {thread.status === "ready" && threadMessages.length === 0 && <p className="byok-card__hint">There are no messages in this conversation any more.</p>}
          {thread.nextBefore && (
            <button type="button" className="byok-linkbtn" disabled={thread.loadingMore} onClick={() => void olderInThread()}>
              {thread.loadingMore ? "Loading..." : "Load older"}
            </button>
          )}
          {threadMessages.length > 0 && (
            <ol className="byok-msgs" aria-label="Messages, oldest first">
              {threadMessages.map((m) => (
                <li key={m.id} className="byok-msg">
                  <span className="byok-msg__meta">
                    <time dateTime={m.receivedAt}>{when(m.receivedAt)}</time>
                    <Badges m={m} />
                  </span>
                  <span className="byok-msg__text">{m.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
