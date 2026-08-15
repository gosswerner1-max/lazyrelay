import { useEffect, useRef, useState } from "react";
import { api, type SupportAction } from "../lib/api";
import botHead from "../assets/support-bot-head.png";
import thinking1 from "../assets/thinking-1.mp4";
import thinking2 from "../assets/thinking-2.mp4";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  escalated?: "hello" | "support" | "accounts" | null;
  action?: SupportAction;
  // Once the customer clicks the button (or it fails), the action is
  // resolved -- the button is replaced with a short result line instead of
  // staying clickable forever or disappearing silently.
  actionResult?: "success" | "error" | null;
}

function platformLabel(platform: string): string {
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

function actionButtonLabel(action: SupportAction): string {
  if (!action) return "";
  if (action.type === "reconnect") return `Reconnect ${platformLabel(action.platform)}`;
  if (action.type === "disconnect") return `Disconnect ${platformLabel(action.platform)}`;
  return "Cancel my subscription";
}

const THINKING_CLIPS = [thinking1, thinking2];

// Widget never sends the previous conversation's escalation flag back to
// the backend — only role/content round-trip, escalated is UI-only state
// derived from each response.
function toApiMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export function SupportWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Index of the message whose action button is currently mid-click — only
  // ever one at a time, since each is its own confirm-then-call round trip.
  const [runningActionIndex, setRunningActionIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Picked once per widget mount, not per message — so the same visitor
  // doesn't see it flicker between two different clips mid-conversation.
  const [thinkingClip] = useState(() => THINKING_CLIPS[Math.floor(Math.random() * THINKING_CLIPS.length)]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, isLoading]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    setError(null);
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);
    try {
      const { reply, escalated, action } = await api.sendSupportChatMessage(toApiMessages(nextMessages));
      setMessages([...nextMessages, { role: "assistant", content: reply, escalated, action, actionResult: null }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  // The AI only ever suggests an action -- nothing happens until the
  // customer clicks this button themselves, same trust boundary as if
  // they'd clicked the equivalent button in the dashboard directly (in
  // fact it calls the exact same api.* functions). Destructive actions get
  // the same native confirm the dashboard's own buttons already use.
  async function handleActionConfirm(index: number, action: SupportAction) {
    if (!action || runningActionIndex !== null) return;
    if (action.type === "disconnect" && !window.confirm(`Disconnect ${platformLabel(action.platform)}? Any scheduled posts still using this account will fail next time they're due.`)) {
      return;
    }
    if (
      action.type === "cancel_subscription" &&
      !window.confirm(
        "Cancel your subscription? You'll keep access until the end of your current billing period. " +
          "30 days after that, your posts and stored media will be permanently deleted — we'll email you a reminder first."
      )
    ) {
      return;
    }
    setRunningActionIndex(index);
    try {
      if (action.type === "reconnect") {
        const { authorizeUrl } = await api.startConnect(action.platform);
        window.location.href = authorizeUrl;
        return; // navigating away -- no result state to set
      }
      if (action.type === "disconnect") {
        await api.disconnectSocialAccount(action.accountId);
      } else if (action.type === "cancel_subscription") {
        // The window.confirm above now states the data-deletion terms
        // explicitly, same substance as the dashboard modal's checkbox --
        // confirming it IS the acknowledgement for this path.
        await api.cancelSubscription(undefined, true);
      }
      setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, actionResult: "success" } : m)));
    } catch {
      setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, actionResult: "error" } : m)));
    } finally {
      setRunningActionIndex(null);
    }
  }

  return (
    <div className="support-widget">
      {isOpen && (
        <div className="support-panel" role="dialog" aria-label="AI Support Assistant">
          <div className="support-panel-header">
            <div className="support-panel-header-title">
              <img src={botHead} alt="" className="support-panel-avatar" />
              <div>
                <p className="support-panel-name">AI Support Assistant</p>
                <p className="support-panel-subtitle">Usually replies in seconds</p>
              </div>
            </div>
            <button type="button" className="support-panel-close" onClick={() => setIsOpen(false)} aria-label="Close support chat">
              &times;
            </button>
          </div>

          <div className="support-panel-messages" ref={listRef}>
            {messages.length === 0 && !isLoading && (
              <p className="support-panel-empty">
                Ask about connecting accounts, scheduling, Proof-of-Publish, plans, or anything else about LazyRelay.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`support-message support-message-${m.role}`}>
                <p>{m.content}</p>
                {m.escalated && (
                  <p className="support-message-escalated">
                    This has been passed to our team — you'll hear back by email.
                  </p>
                )}
                {m.action && m.actionResult == null && (
                  <button
                    type="button"
                    className="support-action-button"
                    disabled={runningActionIndex === i}
                    onClick={() => handleActionConfirm(i, m.action!)}
                  >
                    {runningActionIndex === i ? "Working…" : actionButtonLabel(m.action)}
                  </button>
                )}
                {m.actionResult === "success" && (
                  <p className="support-message-action-result support-message-action-success">✓ Done.</p>
                )}
                {m.actionResult === "error" && (
                  <p className="support-message-action-result support-message-action-error">
                    That didn't go through — try again from the dashboard, or ask me to pass it to the team.
                  </p>
                )}
              </div>
            ))}
            {isLoading && (
              <div className="support-message support-message-assistant support-thinking">
                <video src={thinkingClip} autoPlay loop muted playsInline className="support-thinking-video" />
                <p className="support-thinking-label">Thinking…</p>
              </div>
            )}
            {error && <p className="support-panel-error">{error}</p>}
          </div>

          <form className="support-panel-input" onSubmit={handleSend}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question…"
              maxLength={2000}
              disabled={isLoading}
            />
            <button type="submit" disabled={isLoading || !input.trim()}>
              Send
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        className="support-bubble"
        onClick={() => setIsOpen((v) => !v)}
        aria-label={isOpen ? "Close support chat" : "Open support chat"}
      >
        <span className="support-bubble-ring support-bubble-ring--outer" aria-hidden="true" />
        <span className="support-bubble-ring support-bubble-ring--inner" aria-hidden="true" />
        <img src={botHead} alt="" className="support-bubble-avatar" />
      </button>
    </div>
  );
}
