import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "../lib/api";

/** "Become a partner" form on the landing page (2026-09-29), opened from a
 *  button near the bottom of the page. Same dialog semantics as
 *  PinterestConnectModal (role, aria-modal, focus moved in on open and
 *  handed back on close, Escape to cancel, Tab kept inside) -- but its own
 *  CSS rather than that component's .modal-overlay/.modal-card, since those
 *  live in Dashboard.css (light theme, authenticated app) and this page is
 *  Landing.tsx's dark, unauthenticated theme (App.css).
 *
 *  Deliberately simple, matching Werner's own call: no DB table, no admin
 *  queue on the backend -- submitting just emails him the details, and he
 *  creates the partner's code by hand via the existing --add-partner CLI
 *  once he's reviewed it. */
export function ReferralApplicationModal({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("");
  const [platform, setPlatform] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [channelLink, setChannelLink] = useState("");
  const [audienceSize, setAudienceSize] = useState("");
  const [audienceCountries, setAudienceCountries] = useState("");
  const [preferredPlan, setPreferredPlan] = useState<"A" | "B" | "not sure">("not sure");
  const [howPromote, setHowPromote] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => opener?.focus();
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("input:not([disabled]), textarea:not([disabled]), button:not([disabled])");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setError("");
    try {
      await api.applyForReferralProgram({ name, channel, platform, email, message, channelLink, audienceSize, audienceCountries, preferredPlan, howPromote });
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send your application right now.");
      setStatus("error");
    }
  }

  return (
    <div className="referral-modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div
        ref={dialogRef}
        className="referral-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ outline: "none" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="referral-modal-header">
          <h2 id={titleId}>Become a partner</h2>
          <button type="button" className="referral-modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        {status === "done" ? (
          <p className="referral-modal-done">Thanks — we'll review it and follow up by email.</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <label>
              Name
              <input type="text" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} disabled={status === "loading"} />
            </label>
            <label>
              Channel or handle
              <input
                type="text"
                required
                maxLength={200}
                placeholder="e.g. @yourhandle"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                disabled={status === "loading"}
              />
            </label>
            <label>
              Platform
              <input
                type="text"
                required
                maxLength={100}
                placeholder="e.g. YouTube, TikTok, Instagram"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                disabled={status === "loading"}
              />
            </label>
            <label>
              Link to your channel or website
              <input
                type="url"
                required
                maxLength={500}
                placeholder="https://"
                value={channelLink}
                onChange={(e) => setChannelLink(e.target.value)}
                disabled={status === "loading"}
              />
            </label>
            <label>
              Audience size
              <input
                type="text"
                required
                maxLength={100}
                placeholder="e.g. 12,000 subscribers"
                value={audienceSize}
                onChange={(e) => setAudienceSize(e.target.value)}
                disabled={status === "loading"}
              />
            </label>
            <label>
              Where is your audience mainly?
              <input
                type="text"
                maxLength={200}
                placeholder="e.g. South Africa, UK, USA"
                value={audienceCountries}
                onChange={(e) => setAudienceCountries(e.target.value)}
                disabled={status === "loading"}
              />
            </label>
            <label>
              How would you promote LazyRelay?
              <textarea
                required
                maxLength={1000}
                rows={3}
                placeholder="e.g. a video review, a newsletter mention, posts to my followers"
                value={howPromote}
                onChange={(e) => setHowPromote(e.target.value)}
                disabled={status === "loading"}
              />
            </label>
            <label>
              Which plan interests you?
              <select value={preferredPlan} onChange={(e) => setPreferredPlan(e.target.value as "A" | "B" | "not sure")} disabled={status === "loading"}>
                <option value="not sure">Not sure yet</option>
                <option value="A">Plan A: my audience gets 10% off, I earn 20% for 12 months</option>
                <option value="B">Plan B: no discount, I earn 30% for 3 months then 20% for 9</option>
              </select>
            </label>
            <label>
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={status === "loading"} />
            </label>
            <label>
              Anything else? (optional)
              <textarea
                maxLength={2000}
                rows={3}
                placeholder="Audience size, why you'd like to partner, anything at all"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={status === "loading"}
              />
            </label>
            <p className="referral-modal-note">We use these details only to review your application and to contact you about it.</p>
            {status === "error" && <p className="error">{error}</p>}
            <div className="referral-modal-actions">
              <button type="submit" className="cta" disabled={status === "loading"}>
                {status === "loading" ? "Sending..." : "Submit application"}
              </button>
              <button type="button" className="btn-outline" onClick={onClose} disabled={status === "loading"}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
