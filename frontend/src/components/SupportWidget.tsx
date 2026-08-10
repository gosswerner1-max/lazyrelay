import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import botHead from "../assets/support-bot-head.png";
import thinking1 from "../assets/thinking-1.mp4";
import thinking2 from "../assets/thinking-2.mp4";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  escalated?: "hello" | "support" | "accounts" | null;
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
      const { reply, escalated } = await api.sendSupportChatMessage(toApiMessages(nextMessages));
      setMessages([...nextMessages, { role: "assistant", content: reply, escalated }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — please try again.");
    } finally {
      setIsLoading(false);
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
